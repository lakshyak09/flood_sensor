import { tx } from '../db.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { serializeUser, countDevices } from '../lib/users.js';
import { unclaimDevice } from '../lib/devices.js';
import { badRequest, unauthorized } from '../errors.js';
import { userObject, errorResponse } from '../schemas.js';

export default async function meRoutes(app) {
  const current = (userId) => app.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const withCount = (row) => serializeUser(row, { deviceCount: countDevices(app.db, row.id) });

  // GET /me ------------------------------------------------------------------
  app.get('/me', {
    preHandler: app.authenticateUser,
    schema: { response: { 200: userObject, '4xx': errorResponse } },
  }, async (req) => withCount(req.user));

  // PATCH /me ----------------------------------------------------------------
  app.patch('/me', {
    preHandler: app.authenticateUser,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          display_name: { type: 'string', minLength: 1, maxLength: 100 },
          theme: { type: 'string', enum: ['light', 'dark'] },
          password: { type: 'string', minLength: 10, maxLength: 200 },
          current_password: { type: 'string' },
        },
      },
      response: { 200: userObject, '4xx': errorResponse },
    },
  }, async (req) => {
    const { display_name, theme, password, current_password } = req.body;

    // The pairing rule is "if and only if", so both halves are errors.
    if (password && !current_password) {
      throw badRequest('current_password_required',
        'Changing the password requires the current one.');
    }
    if (current_password && !password) {
      throw badRequest('password_required',
        'current_password is only accepted alongside a new password.');
    }
    if (password && !verifyPassword(current_password, req.user.password_hash)) {
      throw unauthorized('invalid_credentials', 'The current password is incorrect.');
    }

    const sets = [];
    const values = [];
    if (display_name !== undefined) { sets.push('display_name = ?'); values.push(display_name.trim()); }
    if (theme !== undefined) { sets.push('theme = ?'); values.push(theme); }
    if (password !== undefined) { sets.push('password_hash = ?'); values.push(hashPassword(password)); }

    tx(app.db, () => {
      app.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values, req.user.id);

      // A password change ends every other session; the point of changing it is
      // to lock someone out.
      if (password !== undefined) {
        app.db.prepare(
          'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        ).run(app.clock.now().toISOString(), req.user.id);
      }
    });

    return withCount(current(req.user.id));
  });

  // DELETE /me ---------------------------------------------------------------
  app.delete('/me', {
    preHandler: app.authenticateUser,
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        additionalProperties: false,
        properties: { password: { type: 'string' } },
      },
      response: { 204: { type: 'null' }, '4xx': errorResponse },
    },
  }, async (req, reply) => {
    // Authenticated is not enough for something irreversible.
    if (!verifyPassword(req.body.password, req.user.password_hash)) {
      throw unauthorized('invalid_credentials', 'The password is incorrect.');
    }

    tx(app.db, () => {
      const devices = app.db.prepare('SELECT id FROM devices WHERE user_id = ?').all(req.user.id);
      for (const d of devices) unclaimDevice(app.db, d.id);
      app.db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user.id);
      app.db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    });

    reply.code(204);
    return null;
  });
}
