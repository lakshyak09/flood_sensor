import { tx } from '../db.js';
import { forbidden } from '../errors.js';
import {
  MAX_BATCH, deviceConfig, ingestReadings, recordHealth, touchDevice,
} from '../lib/ingest.js';
import { REPORT_STATUSES, VERSION_PATTERN, firmwareFor } from '../lib/firmware.js';
import { recomputeRisk } from '../lib/risk.js';
import { evaluateRiskAlerts, noteDeviceSeen } from '../lib/alerts.js';
import {
  deviceConfigResponse, errorResponse, firmwareResponse, heartbeatResponse, ingestResponse,
} from '../schemas.js';

const firmwareVersion = { type: 'string', minLength: 1, maxLength: 40 };

/**
 * The device names itself in the body as well as proving itself with the key.
 * They must agree: the key decides whose data this is, and a body that disagrees
 * is firmware sending someone else's buffer -- a bug worth surfacing loudly
 * rather than silently filing under the key's owner.
 *
 * It is `403`, not `401`: the credentials were fine. A device that treated this
 * as `401` would sit in fault forever waiting for a key that isn't the problem.
 */
/**
 * Would `currentRisk` hand back a stored score that the readings have since
 * moved on from? True only when a score exists and nothing newer than it has
 * been recorded -- which is the signature of a backlog landing.
 */
function servesStaleScore(db, deviceId) {
  const stored = db.prepare(
    'SELECT max(computed_at) AS at FROM risk_scores WHERE device_id = ?',
  ).get(deviceId)?.at;
  if (!stored) return false;

  const newestReading = db.prepare(
    'SELECT max(recorded_at) AS at FROM readings WHERE device_id = ?',
  ).get(deviceId)?.at;

  return Boolean(newestReading) && stored >= newestReading;
}

function assertBodyMatchesKey(req) {
  if (req.body.device_id !== req.device.id) {
    throw forbidden('device_mismatch', 'That device_id does not match the authenticated device.');
  }
}

export default async function deviceFacingRoutes(app) {
  const reload = (id) => app.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);

  // POST /ingest/readings ----------------------------------------------------
  app.post('/ingest/readings', {
    preHandler: app.authenticateDevice,
    schema: {
      body: {
        type: 'object',
        required: ['device_id', 'readings'],
        additionalProperties: false,
        properties: {
          device_id: { type: 'string', minLength: 1, maxLength: 100 },
          firmware_version: firmwareVersion,
          // Items are deliberately unconstrained here. A schema rejects the
          // whole batch, and one bad reading must not cost the other 499 --
          // each one is checked in the handler so it can be named in `rejected`.
          readings: { type: 'array', minItems: 1, maxItems: MAX_BATCH, items: {} },
        },
      },
      response: { 200: ingestResponse, '4xx': errorResponse },
    },
  }, async (req) => {
    assertBodyMatchesKey(req);
    const now = app.clock.now();

    const result = tx(app.db, () => {
      const stored = ingestReadings(app.db, req.device.id, req.body.readings, now);
      touchDevice(app.db, req.device.id, now, req.body.firmware_version);

      // The device speaking is what ends an offline episode.
      noteDeviceSeen(app.db, req.device, now, { push: app.push });

      // Backfill.
      //
      // `currentRisk` treats a stored score as current while no reading has
      // arrived *since* it was computed. That reads as sound, and it is wrong
      // for the case this product is built around: a device that was offline
      // uploads its backlog, and every one of those readings is timestamped in
      // the past. They never advance `max(recorded_at)` past the stored
      // `computed_at`, so the stale score outlives the data that disproves it --
      // a 1008-reading upload scored `4 (low)` on a device whose real score was
      // `55 (high)`, because the first batch to land happened to be the driest.
      //
      // The condition below is exactly "the cache would now serve a score that
      // the readings no longer support": something was stored, and the newest
      // reading the server holds is still older than it. Normal live ingest
      // never matches -- a reading timestamped now is newer than the last
      // score -- and an account that has never been scored has nothing stored
      // to go stale, so the "toggles off costs nothing" guarantee is untouched.
      if (stored.accepted > 0 && servesStaleScore(app.db, req.device.id)) {
        recomputeRisk(app.db, reload(req.device.id), now);
      }

      // And this is the one place the server scores without being asked to.
      // Section 4 kept scoring off the ingest path on the grounds that whoever
      // next reads the risk will recompute anyway -- true for a screen, useless
      // for a notification: a warning nobody sees until they open the app is
      // not a warning. It scores only for accounts that actually want a risk
      // alert, and is skipped entirely for the ones that don't.
      evaluateRiskAlerts(app.db, reload(req.device.id), now, { push: app.push });
      return stored;
    });

    return {
      ...result,
      server_time: now.toISOString(),
      config_version: reload(req.device.id).config_version,
    };
  });

  // POST /ingest/heartbeat ---------------------------------------------------
  app.post('/ingest/heartbeat', {
    preHandler: app.authenticateDevice,
    schema: {
      body: {
        type: 'object',
        required: ['device_id'],
        additionalProperties: false,
        properties: {
          device_id: { type: 'string', minLength: 1, maxLength: 100 },
          firmware_version: firmwareVersion,
          uptime_s: { type: 'integer', minimum: 0 },
          buffered_readings: { type: 'integer', minimum: 0 },
          storage_free_pct: { type: 'number', minimum: 0, maximum: 100 },
          wifi_rssi: { type: 'integer', minimum: -120, maximum: 0 },
          last_error: { type: ['string', 'null'], maxLength: 500 },
        },
      },
      response: { 200: heartbeatResponse, '4xx': errorResponse },
    },
  }, async (req) => {
    assertBodyMatchesKey(req);
    const now = app.clock.now();

    tx(app.db, () => {
      recordHealth(app.db, req.device.id, now, req.body);
      touchDevice(app.db, req.device.id, now, req.body.firmware_version);
      // A heartbeat is the device saying it is alive, which is exactly what an
      // offline alert was waiting to hear. No risk evaluation: nothing new was
      // measured, so nothing about the risk can have moved.
      noteDeviceSeen(app.db, req.device, now, { push: app.push });
    });

    return { server_time: now.toISOString(), config_version: reload(req.device.id).config_version };
  });

  // GET /device/config -------------------------------------------------------
  app.get('/device/config', {
    preHandler: app.authenticateDevice,
    schema: { response: { 200: deviceConfigResponse, '4xx': errorResponse } },
  }, async (req) => deviceConfig(req.device));

  // GET /device/firmware -----------------------------------------------------
  app.get('/device/firmware', {
    preHandler: app.authenticateDevice,
    schema: {
      querystring: {
        type: 'object',
        required: ['current_version'],
        additionalProperties: false,
        properties: { current_version: { type: 'string', pattern: VERSION_PATTERN } },
      },
      response: { 200: firmwareResponse, '4xx': errorResponse },
    },
  }, async (req) => firmwareFor(app.db, req.query.current_version));

  // POST /device/firmware/report ---------------------------------------------
  app.post('/device/firmware/report', {
    preHandler: app.authenticateDevice,
    schema: {
      body: {
        type: 'object',
        required: ['device_id', 'to_version', 'status'],
        additionalProperties: false,
        properties: {
          device_id: { type: 'string', minLength: 1, maxLength: 100 },
          from_version: { type: ['string', 'null'], maxLength: 40 },
          to_version: firmwareVersion,
          status: { type: 'string', enum: REPORT_STATUSES },
          error: { type: ['string', 'null'], maxLength: 500 },
        },
      },
      response: { 204: { type: 'null' }, '4xx': errorResponse },
    },
  }, async (req, reply) => {
    assertBodyMatchesKey(req);
    const { from_version, to_version, status, error } = req.body;
    const now = app.clock.now().toISOString();

    tx(app.db, () => {
      app.db.prepare(
        `INSERT INTO firmware_reports
           (device_id, reported_at, from_version, to_version, status, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(req.device.id, now, from_version ?? null, to_version, status, error ?? null);

      // A successful flash is the most reliable statement of what a device is
      // running -- more so than the version it mentions on its next upload,
      // which it may not send at all.
      if (status === 'success') {
        app.db.prepare('UPDATE devices SET firmware_version = ? WHERE id = ?')
          .run(to_version, req.device.id);
      }
    });

    reply.code(204);
    return null;
  });
}
