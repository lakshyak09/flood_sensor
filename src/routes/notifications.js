import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { ownedDevice } from '../lib/devices.js';
import {
  DEFAULT_LIMIT, MAX_LIMIT, acknowledgeAlert, listAlerts, sweepOfflineDevices,
} from '../lib/alerts.js';
import {
  PLATFORMS, assertKnownTimezone, preferenceColumns, readPreferences,
} from '../lib/notifications.js';
import {
  alertsResponse, errorResponse, preferencesResponse, pushTokenResponse,
} from '../schemas.js';

const hour = { type: 'integer', minimum: 0, maximum: 23 };

export default async function notificationRoutes(app) {
  // POST /push/tokens --------------------------------------------------------
  app.post('/push/tokens', {
    preHandler: app.authenticateUser,
    schema: {
      body: {
        type: 'object',
        required: ['token', 'platform'],
        additionalProperties: false,
        properties: {
          token: { type: 'string', minLength: 1, maxLength: 500 },
          platform: { type: 'string', enum: PLATFORMS },
          app_version: { type: 'string', maxLength: 40 },
        },
      },
      response: { 201: pushTokenResponse, '4xx': errorResponse },
    },
  }, async (req, reply) => {
    const { token, platform, app_version } = req.body;
    const now = app.clock.now().toISOString();

    // The token is unique across the whole table, not per account. A phone that
    // signs into a second account has to stop receiving the first one's alerts,
    // so registering an existing token moves it rather than duplicating it --
    // which also makes re-registering on every app launch a no-op, as the
    // client is expected to do.
    tx(app.db, () => {
      app.db.prepare(
        `INSERT INTO push_tokens (id, user_id, token, platform, app_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET
           user_id = excluded.user_id, platform = excluded.platform,
           app_version = excluded.app_version, updated_at = excluded.updated_at`,
      ).run(randomUUID(), req.user.id, token, platform, app_version ?? null, now, now);
    });

    reply.code(201);
    return app.db.prepare('SELECT id, platform, created_at FROM push_tokens WHERE token = ?')
      .get(token);
  });

  // DELETE /push/tokens/:token -----------------------------------------------
  app.delete('/push/tokens/:token', {
    preHandler: app.authenticateUser,
    schema: { response: { 204: { type: 'null' }, '4xx': errorResponse } },
  }, async (req, reply) => {
    // 204 whether or not a row went away. This runs on logout and when the OS
    // revokes a token, and neither caller can do anything useful with a 404 --
    // the desired state, "this phone is not registered", already holds.
    tx(app.db, () => {
      app.db.prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?')
        .run(req.params.token, req.user.id);
    });

    reply.code(204);
    return null;
  });

  // GET /notifications/preferences -------------------------------------------
  app.get('/notifications/preferences', {
    preHandler: app.authenticateUser,
    schema: { response: { 200: preferencesResponse, '4xx': errorResponse } },
  }, async (req) => readPreferences(app.db, req.user.id));

  // PUT /notifications/preferences -------------------------------------------
  app.put('/notifications/preferences', {
    preHandler: app.authenticateUser,
    schema: {
      // A full replacement, so every field is required. The settings screen
      // always holds the whole object, and a PATCH would make "I turned that
      // off" depend on which build of the app sent it.
      body: {
        type: 'object',
        required: [
          'risk_high', 'risk_critical', 'device_offline', 'device_recovered',
          'daily_summary', 'daily_summary_hour', 'timezone', 'quiet_hours',
        ],
        additionalProperties: false,
        properties: {
          risk_high: { type: 'boolean' },
          risk_critical: { type: 'boolean' },
          device_offline: { type: 'boolean' },
          device_recovered: { type: 'boolean' },
          daily_summary: { type: 'boolean' },
          daily_summary_hour: hour,
          timezone: { type: 'string', minLength: 1, maxLength: 60 },
          quiet_hours: {
            type: 'object',
            required: ['enabled', 'start_hour', 'end_hour'],
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean' },
              start_hour: hour,
              end_hour: hour,
            },
          },
        },
      },
      response: { 200: preferencesResponse, '4xx': errorResponse },
    },
  }, async (req) => {
    assertKnownTimezone(req.body.timezone);
    const columns = preferenceColumns(req.body);
    const names = Object.keys(columns);

    tx(app.db, () => {
      app.db.prepare(
        `INSERT INTO notification_preferences (user_id, ${names.join(', ')}, updated_at)
         VALUES ($user_id, ${names.map((n) => `$${n}`).join(', ')}, $updated_at)
         ON CONFLICT (user_id) DO UPDATE SET
           ${names.map((n) => `${n} = excluded.${n}`).join(', ')},
           updated_at = excluded.updated_at`,
      ).run({ ...columns, user_id: req.user.id, updated_at: app.clock.now().toISOString() });
    });

    return readPreferences(app.db, req.user.id);
  });

  // GET /alerts --------------------------------------------------------------
  app.get('/alerts', {
    preHandler: app.authenticateUser,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device_id: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
          cursor: { type: 'string' },
        },
      },
      response: { 200: alertsResponse, '4xx': errorResponse },
    },
  }, async (req) => {
    const now = app.clock.now();

    // A device that has gone quiet is only noticed by someone looking, and this
    // is the screen that asks "were you going to tell me?". Sweeping first is
    // what makes the answer honest.
    tx(app.db, () => sweepOfflineDevices(app.db, req.user.id, now, { push: app.push }));

    // Filtering by a device is filtering by *your* device; an id belonging to
    // someone else answers the same 403/404 it would anywhere else, rather than
    // an empty list that reads like "nothing ever happened there".
    if (req.query.device_id) ownedDevice(app.db, req.query.device_id, req.user.id);

    return listAlerts(app.db, req.user.id, {
      deviceId: req.query.device_id,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
  });

  // POST /alerts/:id/acknowledge ---------------------------------------------
  app.post('/alerts/:id/acknowledge', {
    preHandler: app.authenticateUser,
    schema: { response: { 204: { type: 'null' }, '4xx': errorResponse } },
  }, async (req, reply) => {
    tx(app.db, () => acknowledgeAlert(app.db, req.user.id, req.params.id, app.clock.now()));

    reply.code(204);
    return null;
  });
}
