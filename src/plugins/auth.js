import fp from 'fastify-plugin';
import { hashToken, verifyToken } from '../lib/tokens.js';
import { forbidden, unauthorized } from '../errors.js';

/**
 * Decorates the app with the ways in:
 *   `authenticateUser`   -- `Authorization: Bearer <access_token>` -> `req.user`
 *   `authenticateDevice` -- `Authorization: Device <device_key>`   -> `req.device`
 *   `authenticateAdmin`  -- as `authenticateUser`, plus `is_admin`
 *   `identifyUser`       -- as `authenticateUser`, but never throws
 */
async function authPlugin(app) {
  app.decorateRequest('user', null);
  app.decorateRequest('device', null);

  app.decorate('authenticateUser', async (req) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw unauthorized('unauthorized', 'An access token is required.');
    }

    const payload = verifyToken(token, {
      typ: 'access', clock: app.clock, secret: app.jwtSecret,
    });
    if (!payload) throw unauthorized('invalid_token', 'The access token is invalid or expired.');

    const user = app.db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) throw unauthorized('invalid_token', 'The access token is invalid or expired.');

    req.user = user;
  });

  app.decorate('authenticateDevice', async (req) => {
    const header = req.headers.authorization ?? '';
    const [scheme, key] = header.split(' ');

    if (scheme !== 'Device' || !key) {
      throw unauthorized('unauthorized', 'A device key is required.');
    }

    // The key is high-entropy, so a digest lookup is both the right store and a
    // single indexed read -- ingest runs on this path constantly.
    const device = app.db.prepare('SELECT * FROM devices WHERE device_key_hash = ?')
      .get(hashToken(key));

    if (!device) {
      throw unauthorized('invalid_device_credentials', 'That device key is not recognized.');
    }

    // Unclaimed is the same wire answer as deleted, because it is the same
    // situation for the hardware: nobody owns this data. The device shows fault,
    // keeps logging to its buffer, and backs off.
    if (device.user_id === null) {
      throw unauthorized('device_not_claimed', 'That device is not claimed by any account.');
    }

    req.device = device;
  });

  /**
   * Admin is an ordinary session with a flag on it, not a separate credential.
   * A non-admin holding a perfectly valid token is `403`, not `401`: the
   * credentials were fine, and telling the app to go and re-authenticate would
   * send it round a loop that cannot end well.
   */
  app.decorate('authenticateAdmin', async (req) => {
    await app.authenticateUser(req);
    if (!req.user.is_admin) {
      throw forbidden('admin_required', 'This endpoint requires an administrator account.');
    }
  });

  /**
   * Best-effort identification for routes that answer everyone but say more to
   * an operator. A bad token is treated as no token rather than as an error --
   * the route's job is to answer, and `GET /admin/health` in particular is
   * something a load balancer calls with no credentials at all.
   */
  app.decorate('identifyUser', async (req) => {
    try {
      await app.authenticateUser(req);
    } catch {
      req.user = null;
    }
  });
}

export default fp(authPlugin);
