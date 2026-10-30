import { forbidden, notFound } from '../errors.js';
import { currentRisk } from './risk.js';

/** `online` is derived, never stored: last seen within the last 30 minutes. */
export const ONLINE_WINDOW_MS = 30 * 60_000;

export function isOnline(lastSeenAt, now) {
  if (!lastSeenAt) return false;
  return now.getTime() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS;
}

/**
 * Load a device the caller is allowed to touch.
 *   404 if no such device exists at all
 *   403 if it exists but belongs to someone else
 */
export function ownedDevice(db, deviceId, userId) {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!row || row.user_id === null) {
    throw notFound('device_not_found', 'No device with that id belongs to this account.');
  }
  if (row.user_id !== userId) {
    throw forbidden('forbidden', 'No device with that id belongs to this account.');
  }
  return row;
}

function latestReading(db, deviceId) {
  return db.prepare(
    `SELECT recorded_at, temperature_c, humidity_pct, dew_point_c
       FROM readings WHERE device_id = ? ORDER BY recorded_at DESC LIMIT 1`,
  ).get(deviceId) ?? null;
}

// One definition of "this device's risk" for the whole API, so the home screen
// and the detail screen can never disagree. It only recomputes when a reading
// has arrived since the stored score, so listing devices is a read in the
// common case.
const latestRisk = (db, row, now) => currentRisk(db, row, now);

/** The dashboard card: name, location, alive or not, the two numbers, the risk. */
export function serializeDeviceListItem(db, row, now) {
  const reading = latestReading(db, row.id);
  const risk = latestRisk(db, row, now);

  return {
    id: row.id,
    name: row.name,
    location: row.location,
    online: isOnline(row.last_seen_at, now),
    last_seen_at: row.last_seen_at,
    latest_reading: reading && {
      recorded_at: reading.recorded_at,
      temperature_c: reading.temperature_c,
      humidity_pct: reading.humidity_pct,
    },
    risk: risk && { score: risk.score, level: risk.level },
  };
}

/** The detail page: everything the card has, plus counters and the why. */
export function serializeDeviceDetail(db, row, now) {
  const reading = latestReading(db, row.id);
  const risk = latestRisk(db, row, now);
  const counts = db.prepare(
    `SELECT count(*) AS total, min(recorded_at) AS first FROM readings WHERE device_id = ?`,
  ).get(row.id);

  return {
    id: row.id,
    name: row.name,
    location: row.location,
    surface_material: row.surface_material,
    online: isOnline(row.last_seen_at, now),
    last_seen_at: row.last_seen_at,
    firmware_version: row.firmware_version,
    reading_count: counts.total,
    first_reading_at: counts.first,
    latest_reading: reading,
    risk: risk && {
      score: risk.score,
      level: risk.level,
      recommendation: risk.recommendation,
      computed_at: risk.computed_at,
    },
    created_at: row.created_at,
  };
}

/**
 * Return a device to the unclaimed state and drop everything the previous owner
 * generated. The hardware keeps running and starts getting 401 on ingest.
 */
export function unclaimDevice(db, deviceId) {
  db.prepare('DELETE FROM readings WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM risk_scores WHERE device_id = ?').run(deviceId);
  // The alerts go with the history they describe -- they name a device this
  // account no longer has, and the next owner must not inherit them. The
  // edge-trigger state goes too, so a device reclaimed while quiet is not
  // already halfway through an offline episode nobody was told about.
  db.prepare('DELETE FROM alerts WHERE device_id = ?').run(deviceId);
  db.prepare(
    `UPDATE devices
        SET user_id = NULL, name = NULL, location = NULL,
            surface_material = 'unknown', claimed_at = NULL,
            alerted_level = NULL, offline_alerted = 0,
            config_version = config_version + 1
      WHERE id = ?`,
  ).run(deviceId);
}
