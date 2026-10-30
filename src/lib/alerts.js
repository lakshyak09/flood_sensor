// Alerts: deciding that something is worth telling the owner about, and keeping
// a record of having told them.
//
// Two things shape everything here.
//
// Almost nothing in this server wakes up on its own, so an alert is normally
// produced by something that was going to happen anyway -- a reading arriving,
// or someone opening the app. Each rule below names the event it rides on.
//
// The exception is silence, which by definition sends no event. `lib/sweeper.js`
// is a timer that exists solely to find it, because a sensor that died is the
// one warning that must not wait for someone to open the app and ask.
//
// Alerting is edge-triggered. A device sitting at critical for a week is one
// alert, not twenty thousand: the state that was last announced is remembered
// on the device row, and only a change from it produces anything.

import { randomUUID } from 'node:crypto';
import { ONLINE_WINDOW_MS } from './devices.js';
import { currentRisk } from './risk.js';
import { deliveryFor, readPreferences } from './notifications.js';
import { decodeCursor, paginate } from './pagination.js';
import { badRequest, notFound, unprocessable } from '../errors.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

const LEVEL_RANK = { low: 0, moderate: 1, high: 2, critical: 3 };

const displayName = (device) => device.name ?? 'A sensor';

/**
 * Write an alert, if the owner's preferences want it at all.
 *
 * Returns the stored row, or null when the preference is off -- "off" means the
 * event was never news to this account, so there is nothing to record either.
 * Quiet hours are the other case entirely: the alert is stored, with `notified`
 * false, because the history screen answering "did it warn me?" must not depend
 * on what time of night it was.
 */
export function recordAlert(db, { userId, device, type, firedAt, score = null, level = null, message, preferences, push }) {
  const prefs = preferences ?? readPreferences(db, userId);
  const delivery = deliveryFor(prefs, type, new Date(firedAt));
  if (!delivery) return null;

  const id = randomUUID();
  db.prepare(
    `INSERT INTO alerts
       (id, user_id, device_id, device_name, type, fired_at, score, level, message, notified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, device?.id ?? null, device?.name ?? null, type, firedAt,
        score, level, message, delivery.notified ? 1 : 0);

  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);

  // The phone is told here, at the one point that already knows whether this
  // account wanted to hear about it and whether the hour was a quiet one. A
  // push sent anywhere else could disagree with `notified`, and then the
  // settings screen would be describing something that isn't happening.
  push?.deliver(db, alert);

  return alert;
}

/**
 * Risk alerts, evaluated when a reading lands.
 *
 * This is the one place the server scores a device without being asked to. It
 * has to be: a warning the owner only discovers by opening the app is not a
 * warning, it is a screen. The cost is bounded the same way every other
 * recompute is -- one pass over at most a week of one device's readings -- and
 * an account with both risk toggles off pays nothing at all, because the
 * preference is read before the model runs.
 */
export function evaluateRiskAlerts(db, device, now, { push } = {}) {
  if (device.user_id === null) return null;

  const prefs = readPreferences(db, device.user_id);
  if (!prefs.risk_high && !prefs.risk_critical) return null;

  const risk = currentRisk(db, device, now);
  if (!risk) return null;

  const announced = device.alerted_level;

  // Back in the safe range: the episode is over, so the next spike gets to
  // speak up again.
  if (LEVEL_RANK[risk.level] < LEVEL_RANK.high) {
    if (announced !== null) {
      db.prepare('UPDATE devices SET alerted_level = NULL WHERE id = ?').run(device.id);
    }
    return null;
  }

  // Nothing new to say while the device is somewhere we have already announced.
  if (announced !== null && LEVEL_RANK[risk.level] <= LEVEL_RANK[announced]) return null;

  const type = risk.level === 'critical' ? 'risk_critical' : 'risk_high';
  const label = risk.level === 'critical' ? 'Critical' : 'High';

  // The level is remembered whether or not an alert is stored. A user with
  // `risk_high` off who turns it on mid-episode should not be told about a
  // spike that started days ago -- they asked to hear about the next one.
  db.prepare('UPDATE devices SET alerted_level = ? WHERE id = ?').run(risk.level, device.id);

  return recordAlert(db, {
    userId: device.user_id,
    device,
    type,
    firedAt: now.toISOString(),
    score: risk.score,
    level: risk.level,
    message: `${displayName(device)} hit ${label} risk.`,
    preferences: prefs,
    push,
  });
}

/**
 * The device is talking again, evaluated on ingest and heartbeat.
 *
 * Only fires against an outstanding offline alert: a device that never went
 * quiet has not recovered from anything.
 */
export function noteDeviceSeen(db, device, now, { push } = {}) {
  if (device.user_id === null || device.offline_alerted !== 1) return null;

  db.prepare('UPDATE devices SET offline_alerted = 0 WHERE id = ?').run(device.id);

  return recordAlert(db, {
    userId: device.user_id,
    device,
    type: 'device_recovered',
    firedAt: now.toISOString(),
    message: `${displayName(device)} is reporting again.`,
    push,
  });
}

/**
 * Devices that have gone quiet, evaluated when the owner looks.
 *
 * Silence is the one event nothing tells us about, so it is noticed rather than
 * received -- `GET /devices` and `GET /alerts` both sweep before answering.
 * Detection is lazy but the timestamp is not: `fired_at` is the moment the
 * device crossed the threshold, which is exactly knowable from `last_seen_at`,
 * so an alert found at noon still says the sensor stopped at 03:14.
 *
 * A device that has never reported is skipped. It has not gone quiet; it has
 * never spoken, and that is the setup screen's problem, not an alert.
 */
export function sweepOfflineDevices(db, userId, now, { push } = {}) {
  const prefs = readPreferences(db, userId);
  const fired = [];

  const candidates = db.prepare(
    `SELECT * FROM devices
      WHERE user_id = ? AND offline_alerted = 0 AND last_seen_at IS NOT NULL`,
  ).all(userId);

  for (const device of candidates) {
    const goneQuietAt = new Date(device.last_seen_at).getTime() + ONLINE_WINDOW_MS;
    if (goneQuietAt > now.getTime()) continue;

    db.prepare('UPDATE devices SET offline_alerted = 1 WHERE id = ?').run(device.id);

    const alert = recordAlert(db, {
      userId,
      device,
      type: 'device_offline',
      firedAt: new Date(goneQuietAt).toISOString(),
      message: `${displayName(device)} has stopped reporting.`,
      preferences: prefs,
      push,
    });
    if (alert) fired.push(alert);
  }

  return fired;
}

/** Reset the edge-trigger state. Unclaiming makes both flags meaningless. */
export function clearAlertState(db, deviceId) {
  db.prepare('UPDATE devices SET alerted_level = NULL, offline_alerted = 0 WHERE id = ?')
    .run(deviceId);
}

// --- Listing ------------------------------------------------------------------

// Paged on (fired_at, id) -- see lib/pagination.js for why not an offset.

export function serializeAlert(row) {
  return {
    id: row.id,
    device_id: row.device_id,
    device_name: row.device_name,
    type: row.type,
    fired_at: row.fired_at,
    score: row.score,
    level: row.level,
    message: row.message,
    notified: row.notified === 1,
    acknowledged_at: row.acknowledged_at,
  };
}

/**
 * A page of alert history, newest first.
 *
 * Unlike the reading routes there is no default range: "what was I told" means
 * everything, and a history screen that silently started 24 hours ago would be
 * answering a question nobody asked.
 */
export function listAlerts(db, userId, { deviceId, from, to, limit = DEFAULT_LIMIT, cursor } = {}) {
  const where = ['user_id = $userId'];
  const args = { userId, limit: limit + 1 };

  if (deviceId) { where.push('device_id = $deviceId'); args.deviceId = deviceId; }

  for (const [key, value, op] of [['from', from, '>='], ['to', to, '<']]) {
    if (!value) continue;
    const t = new Date(value);
    if (Number.isNaN(t.getTime())) {
      throw badRequest('validation_failed', '`from` and `to` must be ISO 8601 timestamps.');
    }
    where.push(`fired_at ${op} $${key}`);
    args[key] = t.toISOString();
  }
  if (from && to && new Date(from).getTime() >= new Date(to).getTime()) {
    throw unprocessable('invalid_range', '`from` must be before `to`.');
  }

  if (cursor) {
    const { at, id } = decodeCursor(cursor);
    where.push('(fired_at < $cursorAt OR (fired_at = $cursorAt AND id < $cursorId))');
    args.cursorAt = at;
    args.cursorId = id;
  }

  const rows = db.prepare(
    `SELECT * FROM alerts
      WHERE ${where.join(' AND ')}
      ORDER BY fired_at DESC, id DESC
      LIMIT $limit`,
  ).all(args);

  const { kept, next_cursor } = paginate(rows, limit, (row) => [row.fired_at, row.id]);

  return { alerts: kept.map(serializeAlert), next_cursor };
}

/**
 * Mark one alert seen. Acknowledging twice is not an error -- the badge is
 * already clear -- but the first time is the one that is remembered.
 */
export function acknowledgeAlert(db, userId, alertId, now) {
  const row = db.prepare('SELECT * FROM alerts WHERE id = ? AND user_id = ?').get(alertId, userId);
  if (!row) throw notFound('alert_not_found', 'No alert with that id belongs to this account.');

  if (row.acknowledged_at === null) {
    db.prepare('UPDATE alerts SET acknowledged_at = ? WHERE id = ?')
      .run(now.toISOString(), alertId);
  }
  return row;
}
