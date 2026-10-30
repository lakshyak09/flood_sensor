import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { tx } from '../db.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { signAccessToken, signRefreshToken, verifyToken, hashToken } from '../lib/tokens.js';
import { serializeUser } from '../lib/users.js';
import { conflict, unauthorized } from '../errors.js';
import { tokenBundle, errorResponse } from '../schemas.js';

const emailSchema = { type: 'string', format: 'email', maxLength: 320 };
const passwordSchema = { type: 'string', minLength: 10, maxLength: 200 };

/** Mint an access/refresh pair and record the refresh token so it can be rotated. */
function issueSession(app, user) {
  const now = app.clock.now();
  const access = signAccessToken({ userId: user.id, clock: app.clock, secret: app.jwtSecret });
  const refresh = signRefreshToken({ userId: user.id, clock: app.clock, secret: app.jwtSecret });

  app.db.prepare(
    `INSERT INTO refresh_tokens (jti, user_id, token_hash, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(refresh.jti, user.id, hashToken(refresh.token), now.toISOString(), refresh.expiresAt);

  return {
    access_token: access,
    refresh_token: refresh.token,
    expires_in: config.accessTokenTtlS,
  };
}

export default async function authRoutes(app) {
  // POST /auth/register ------------------------------------------------------
  app.post('/auth/register', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        additionalProperties: false,
        properties: {
          email: emailSchema,
          password: passwordSchema,
          display_name: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
      response: { 201: tokenBundle, '4xx': errorResponse },
    },
  }, async (req, reply) => {
    const email = req.body.email.trim().toLowerCase();
    const displayName = req.body.display_name?.trim() || email.split('@')[0];
    const now = app.clock.now().toISOString();

    const existing = app.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
    if (existing) throw conflict('email_taken', 'That email address is already registered.');

    const user = {
      id: randomUUID(),
      email,
      password_hash: hashPassword(req.body.password),
      display_name: displayName,
      is_admin: 0,
      theme: 'light',
      created_at: now,
    };

    const session = tx(app.db, () => {
      app.db.prepare(
        `INSERT INTO users (id, email, password_hash, display_name, is_admin, theme, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(user.id, user.email, user.password_hash, user.display_name,
            user.is_admin, user.theme, user.created_at);
      return issueSession(app, user);
    });

    reply.code(201);
    return { user: serializeUser(user), ...session };
  });

  // POST /auth/login ---------------------------------------------------------
  app.post('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        additionalProperties: false,
        properties: { email: { type: 'string' }, password: { type: 'string' } },
      },
      response: { 200: tokenBundle, '4xx': errorResponse },
    },
  }, async (req) => {
    // One message for "no such account" and "wrong password" alike: which of the
    // two it was is not the caller's business.
    const vague = () => unauthorized('invalid_credentials', 'Email or password is incorrect.');

    const email = req.body.email.trim().toLowerCase();
    const user = app.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) throw vague();
    if (!verifyPassword(req.body.password, user.password_hash)) throw vague();

    const now = app.clock.now().toISOString();
    app.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);

    return { user: serializeUser(user), ...issueSession(app, user) };
  });

  // POST /auth/refresh -------------------------------------------------------
  app.post('/auth/refresh', {
    schema: {
      body: {
        type: 'object',
        required: ['refresh_token'],
        additionalProperties: false,
        properties: { refresh_token: { type: 'string' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            access_token: { type: 'string' },
            refresh_token: { type: 'string' },
            expires_in: { type: 'integer' },
          },
        },
        '4xx': errorResponse,
      },
    },
  }, async (req) => {
    const presented = req.body.refresh_token;
    const invalid = () =>
      unauthorized('invalid_refresh_token', 'That refresh token is invalid or expired.');

    const payload = verifyToken(presented, {
      typ: 'refresh', clock: app.clock, secret: app.jwtSecret,
    });
    if (!payload) throw invalid();

    const stored = app.db.prepare('SELECT * FROM refresh_tokens WHERE jti = ?').get(payload.jti);
    if (!stored || stored.token_hash !== hashToken(presented)) throw invalid();

    // A spent token coming back means it was captured, or a client is confused.
    // Either way the safe move is to end every session for that account.
    if (stored.revoked_at) {
      app.db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(app.clock.now().toISOString(), stored.user_id);
      throw invalid();
    }

    const user = app.db.prepare('SELECT * FROM users WHERE id = ?').get(stored.user_id);
    if (!user) throw invalid();

    return tx(app.db, () => {
      app.db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE jti = ?')
        .run(app.clock.now().toISOString(), stored.jti);
      return issueSession(app, user);
    });
  });

  // POST /auth/logout --------------------------------------------------------
  app.post('/auth/logout', {
    preHandler: app.authenticateUser,
    schema: {
      body: {
        type: 'object',
        required: ['refresh_token'],
        additionalProperties: false,
        properties: { refresh_token: { type: 'string' } },
      },
      response: { 204: { type: 'null' }, '4xx': errorResponse },
    },
  }, async (req, reply) => {
    const hash = hashToken(req.body.refresh_token);
    app.db.prepare(
      `UPDATE refresh_tokens SET revoked_at = ?
        WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL`,
    ).run(app.clock.now().toISOString(), hash, req.user.id);

    // Idempotent: logging out twice, or with a token already dead, is still 204.
    reply.code(204);
    return null;
  });
}
