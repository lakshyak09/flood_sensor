// Taking readings off a sensor.
//
// The shape of this endpoint is set by what the hardware is: a device with a
// small buffer, an unreliable radio and a clock nobody synchronised. So the
// batch is idempotent (retrying costs nothing), partially acceptable (one bad
// reading doesn't cost the other 499) and answers with a watermark the device
// can trim its buffer against.

import { dewPointC } from './risk.js';

export const MAX_BATCH = 500;

/** Sensor range, not room range: outside this the reading is a fault, not weather. */
export const TEMPERATURE_RANGE = [-40, 125];
export const HUMIDITY_RANGE = [0, 100];

/**
 * How far ahead of the server a device's clock may be. A device that has never
 * reached the internet boots at some arbitrary time, and readings it timestamps
 * before it corrects itself would otherwise sit in the future forever, poisoning
 * every "latest" query. Behind is fine -- that's just a device catching up after
 * an outage, which is the normal case.
 */
export const MAX_CLOCK_SKEW_MS = 24 * 3_600_000;

const inRange = (n, [lo, hi]) => n >= lo && n <= hi;
const isFinite_ = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Check one reading off the wire.
 * @returns `{ value }` for a keeper, or `{ reason }` naming exactly what was wrong.
 */
export function validateReading(raw, now) {
  if (raw === null || typeof raw !== 'object') return { reason: 'not_an_object' };

  const { recorded_at, temperature_c, humidity_pct } = raw;

  if (typeof recorded_at !== 'string') return { reason: 'missing_recorded_at' };
  const t = new Date(recorded_at);
  if (Number.isNaN(t.getTime())) return { reason: 'invalid_recorded_at' };
  if (t.getTime() - now.getTime() > MAX_CLOCK_SKEW_MS) return { reason: 'recorded_at_in_future' };

  if (!isFinite_(temperature_c)) return { reason: 'missing_temperature_c' };
  if (!inRange(temperature_c, TEMPERATURE_RANGE)) return { reason: 'temperature_c_out_of_range' };

  if (!isFinite_(humidity_pct)) return { reason: 'missing_humidity_pct' };
  if (!inRange(humidity_pct, HUMIDITY_RANGE)) return { reason: 'humidity_pct_out_of_range' };

  return {
    value: {
      // Normalised, not stored as sent: `(device_id, recorded_at)` is the
      // dedupe key, so two spellings of the same instant must not become two
      // rows.
      recorded_at: t.toISOString(),
      temperature_c,
      humidity_pct,
      // Derived here rather than on the device: it is arithmetic the firmware
      // shouldn't own, and a formula fix shouldn't need an OTA update.
      dew_point_c: dewPointC(temperature_c, humidity_pct),
    },
  };
}

/**
 * Store a batch. Valid readings go in; invalid ones are named and skipped.
 *
 * `ON CONFLICT DO NOTHING` is what makes a retry free, and first-write-wins is
 * deliberate: a device re-sending a reading is retrying, not correcting.
 */
export function ingestReadings(db, deviceId, rawReadings, now) {
  const insert = db.prepare(
    `INSERT INTO readings (device_id, recorded_at, temperature_c, humidity_pct, dew_point_c)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (device_id, recorded_at) DO NOTHING`,
  );

  const rejected = [];
  let accepted = 0;
  let duplicates = 0;

  rawReadings.forEach((raw, index) => {
    const { value, reason } = validateReading(raw, now);
    if (!value) {
      rejected.push({ index, reason });
      return;
    }
    const { changes } = insert.run(
      deviceId, value.recorded_at, value.temperature_c, value.humidity_pct, value.dew_point_c,
    );
    if (changes > 0) accepted += 1;
    else duplicates += 1;
  });

  // The watermark is what the server holds, not what this batch contained -- so
  // a batch that was entirely duplicates still tells the device it may trim.
  const last = db.prepare('SELECT max(recorded_at) AS at FROM readings WHERE device_id = ?')
    .get(deviceId)?.at ?? null;

  return { accepted, duplicates, rejected, last_recorded_at: last };
}

/**
 * Mark a device as having just been heard from. Firmware version is recorded
 * whenever the device mentions it, so the fleet view reflects reality without a
 * separate report.
 */
export function touchDevice(db, deviceId, now, firmwareVersion) {
  if (firmwareVersion) {
    db.prepare('UPDATE devices SET last_seen_at = ?, firmware_version = ? WHERE id = ?')
      .run(now.toISOString(), firmwareVersion, deviceId);
  } else {
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .run(now.toISOString(), deviceId);
  }
}

/** Latest health only: this is current state, not a log. */
export function recordHealth(db, deviceId, now, health) {
  db.prepare(
    `INSERT INTO device_health
       (device_id, reported_at, uptime_s, buffered_readings, storage_free_pct, wifi_rssi, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE SET
       reported_at = excluded.reported_at, uptime_s = excluded.uptime_s,
       buffered_readings = excluded.buffered_readings,
       storage_free_pct = excluded.storage_free_pct,
       wifi_rssi = excluded.wifi_rssi, last_error = excluded.last_error`,
  ).run(deviceId, now.toISOString(),
        health.uptime_s ?? null, health.buffered_readings ?? null,
        health.storage_free_pct ?? null, health.wifi_rssi ?? null, health.last_error ?? null);
}

/** The whole of what a device is told about itself. */
export function deviceConfig(row) {
  return {
    config_version: row.config_version,
    sample_interval_s: row.sample_interval_s,
    upload_interval_s: row.upload_interval_s,
    heartbeat_interval_s: row.heartbeat_interval_s,
    led_enabled: row.led_enabled === 1,
  };
}
