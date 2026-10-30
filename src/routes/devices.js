import { tx } from '../db.js';
import { hashToken } from '../lib/tokens.js';
import {
  ownedDevice, serializeDeviceDetail, serializeDeviceListItem, unclaimDevice,
} from '../lib/devices.js';
import { recomputeRisk } from '../lib/risk.js';
import { sweepOfflineDevices } from '../lib/alerts.js';
import { conflict, unauthorized } from '../errors.js';
import { deviceDetail, deviceListItem, errorResponse, surfaceMaterials } from '../schemas.js';

export default async function deviceRoutes(app) {
  const byId = (id) => app.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);

  // POST /devices/claim ------------------------------------------------------
  app.post('/devices/claim', {
    preHandler: app.authenticateUser,
    schema: {
      body: {
        type: 'object',
        required: ['device_id', 'device_key', 'name'],
        additionalProperties: false,
        properties: {
          device_id: { type: 'string', minLength: 1, maxLength: 100 },
          device_key: { type: 'string', minLength: 1, maxLength: 200 },
          name: { type: 'string', minLength: 1, maxLength: 100 },
          location: { type: 'string', maxLength: 100 },
          surface_material: { type: 'string', enum: surfaceMaterials },
        },
      },
      response: { 201: deviceDetail, '4xx': errorResponse },
    },
  }, async (req, reply) => {
    const { device_id, device_key, name, location, surface_material } = req.body;
    const row = byId(device_id);

    // An unknown id and a wrong key are the same answer -- otherwise this route
    // tells anyone which device ids exist.
    const keyMatches = row && hashToken(device_key) === row.device_key_hash;
    if (!keyMatches) {
      throw unauthorized('invalid_device_credentials',
        'That device id and key do not match a known device.');
    }
    if (row.user_id !== null) {
      throw conflict('device_already_claimed', 'That device is already claimed.');
    }

    const now = app.clock.now().toISOString();
    tx(app.db, () => {
      app.db.prepare(
        `UPDATE devices
            SET user_id = ?, name = ?, location = ?, surface_material = ?,
                claimed_at = ?, config_version = config_version + 1
          WHERE id = ?`,
      ).run(req.user.id, name.trim(), location?.trim() ?? null,
            surface_material ?? 'unknown', now, device_id);
    });

    reply.code(201);
    return serializeDeviceDetail(app.db, byId(device_id), app.clock.now());
  });

  // GET /devices -------------------------------------------------------------
  app.get('/devices', {
    preHandler: app.authenticateUser,
    schema: {
      response: {
        200: {
          type: 'object',
          properties: { devices: { type: 'array', items: deviceListItem } },
        },
        '4xx': errorResponse,
      },
    },
  }, async (req) => {
    const now = app.clock.now();

    // Nothing arrives to say a sensor stopped talking, so the home screen is
    // one of the two places that notices. See `sweepOfflineDevices`: the alert
    // is dated when the device actually went quiet, not when we looked.
    tx(app.db, () => sweepOfflineDevices(app.db, req.user.id, now, { push: app.push }));

    const rows = app.db.prepare(
      'SELECT * FROM devices WHERE user_id = ? ORDER BY claimed_at ASC',
    ).all(req.user.id);

    return { devices: rows.map((row) => serializeDeviceListItem(app.db, row, now)) };
  });

  // GET /devices/:id ---------------------------------------------------------
  app.get('/devices/:id', {
    preHandler: app.authenticateUser,
    schema: { response: { 200: deviceDetail, '4xx': errorResponse } },
  }, async (req) => {
    const row = ownedDevice(app.db, req.params.id, req.user.id);
    return serializeDeviceDetail(app.db, row, app.clock.now());
  });

  // PATCH /devices/:id -------------------------------------------------------
  app.patch('/devices/:id', {
    preHandler: app.authenticateUser,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          location: { type: ['string', 'null'], maxLength: 100 },
          surface_material: { type: 'string', enum: surfaceMaterials },
        },
      },
      response: { 200: deviceDetail, '4xx': errorResponse },
    },
  }, async (req) => {
    const row = ownedDevice(app.db, req.params.id, req.user.id);
    const { name, location, surface_material } = req.body;

    const sets = [];
    const values = [];
    if (name !== undefined) { sets.push('name = ?'); values.push(name.trim()); }
    if (location !== undefined) { sets.push('location = ?'); values.push(location?.trim() ?? null); }
    if (surface_material !== undefined) { sets.push('surface_material = ?'); values.push(surface_material); }

    const materialChanged = surface_material !== undefined && surface_material !== row.surface_material;

    const now = app.clock.now();

    tx(app.db, () => {
      app.db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...values, row.id);

      // The model is material-dependent, so every stored score describes a
      // device that no longer exists. Discard them and score again from the
      // history we already have -- one pass over at most a week of readings for
      // one device, which is cheap enough to do before answering.
      if (materialChanged) {
        recomputeRisk(app.db, { ...row, surface_material }, now, { invalidateHistory: true });
      }
    });

    return serializeDeviceDetail(app.db, byId(row.id), now);
  });

  // DELETE /devices/:id ------------------------------------------------------
  app.delete('/devices/:id', {
    preHandler: app.authenticateUser,
    schema: { response: { 204: { type: 'null' }, '4xx': errorResponse } },
  }, async (req, reply) => {
    const row = ownedDevice(app.db, req.params.id, req.user.id);
    tx(app.db, () => unclaimDevice(app.db, row.id));

    reply.code(204);
    return null;
  });
}
