// Reading history for charts.
//
// At 30-second sampling a week of raw data is ~20k points, which no chart wants
// and no phone should download. Bucketing happens in SQL -- SQLite reads ISO
// 8601 text as a timestamp, so a bucket key is just epoch seconds floored to the
// bucket width -- and the aggregation returns the mean plus the humidity
// extremes, because for mold the peaks are the interesting part.

import { dewPointC } from './risk.js';
import { badRequest, unprocessable } from '../errors.js';

/** Bucket widths in seconds. `raw` means no aggregation. */
export const BUCKETS = { raw: 0, '1m': 60, '5m': 300, '1h': 3600, '1d': 86_400 };
export const BUCKET_NAMES = ['auto', ...Object.keys(BUCKETS)];

export const DEFAULT_LIMIT = 2000;
export const MAX_LIMIT = 10_000;

/** What `auto` aims for: enough resolution to see shape, small enough to send. */
export const TARGET_POINTS = 1000;

const HOUR_MS = 3_600_000;
const round2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

/** `toOp` is interpolated into SQL, so it never gets to be anything but these. */
const upperBound = (op) => {
  if (op !== '<' && op !== '<=') throw new Error(`bad range operator: ${op}`);
  return op;
};

/**
 * Pick the coarsest bucket that keeps the response near TARGET_POINTS.
 * Raw only survives short ranges: at 30-second sampling, 1000 points is ~8 hours.
 */
export function chooseBucket(fromMs, toMs) {
  const perPointS = Math.max(1, (toMs - fromMs) / 1000) / TARGET_POINTS;
  if (perPointS <= 30) return 'raw';
  return ['1m', '5m', '1h', '1d'].find((name) => BUCKETS[name] >= perPointS) ?? '1d';
}

/**
 * Resolve `from`/`to` from a query. `to` defaults to now and `from` to 24 hours
 * before `to` -- before `to`, not before now, so narrowing to a past day works
 * by passing `to` alone.
 *
 * An explicit `to` is exclusive, so paging by feeding one window's `to` in as
 * the next window's `from` counts every point exactly once. A defaulted `to` is
 * inclusive instead: it means "up to now", and a score computed this very
 * millisecond should not be invisible to the screen that just asked for it.
 */
export function parseRange(query, now, { defaultSpanHours = 24 } = {}) {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from)
    : new Date(to.getTime() - defaultSpanHours * HOUR_MS);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw badRequest('validation_failed', '`from` and `to` must be ISO 8601 timestamps.');
  }
  if (from.getTime() >= to.getTime()) {
    throw unprocessable('invalid_range', '`from` must be before `to`.');
  }
  return { from, to, toOp: query.to ? '<' : '<=' };
}

/**
 * Read a device's history. `from` is inclusive, `to` exclusive.
 *
 * `limit` keeps the newest points and reports `truncated`, rather than silently
 * returning a chart that stops early with no way to tell.
 */
export function queryReadings(db, deviceId, { from, to, toOp = '<', bucket = 'auto', limit = DEFAULT_LIMIT }) {
  const resolved = bucket === 'auto' ? chooseBucket(from.getTime(), to.getTime()) : bucket;
  const op = upperBound(toOp);
  const args = [deviceId, from.toISOString(), to.toISOString(), limit + 1];

  const rows = resolved === 'raw'
    ? db.prepare(
      `SELECT recorded_at, temperature_c, humidity_pct, dew_point_c
         FROM readings
        WHERE device_id = ? AND recorded_at >= ? AND recorded_at ${op} ?
        ORDER BY recorded_at DESC LIMIT ?`,
    ).all(...args)
    : db.prepare(
      `SELECT CAST(strftime('%s', recorded_at) AS INTEGER) / $width * $width AS bucket_s,
              avg(temperature_c) AS temperature_c,
              avg(humidity_pct)  AS humidity_pct,
              avg(dew_point_c)   AS dew_point_c,
              min(humidity_pct)  AS humidity_min,
              max(humidity_pct)  AS humidity_max,
              count(*)           AS sample_count,
              count(dew_point_c) AS dew_point_count
         FROM readings
        WHERE device_id = $id AND recorded_at >= $from AND recorded_at ${op} $to
        GROUP BY bucket_s
        ORDER BY bucket_s DESC LIMIT $limit`,
    ).all({
      id: deviceId, from: args[1], to: args[2], limit: args[3],
      // A bigint, not a number: node:sqlite binds JS numbers as REAL, and
      // `INTEGER / REAL` is float division, which would never floor to a bucket.
      width: BigInt(BUCKETS[resolved]),
    });

  const truncated = rows.length > limit;
  const kept = (truncated ? rows.slice(0, limit) : rows).reverse();

  const points = resolved === 'raw'
    ? kept.map((r) => ({
      t: r.recorded_at,
      temperature_c: r.temperature_c,
      humidity_pct: r.humidity_pct,
      dew_point_c: r.dew_point_c ?? round2(dewPointC(r.temperature_c, r.humidity_pct)),
    }))
    : kept.map((r) => ({
      t: new Date(r.bucket_s * 1000).toISOString(),
      temperature_c: round2(r.temperature_c),
      humidity_pct: round2(r.humidity_pct),
      // Averaging a column that is null for some samples would silently mean
      // something different per bucket, so fall back to deriving it from the
      // bucket's own means unless every sample in it stored one.
      dew_point_c: r.dew_point_count === r.sample_count
        ? round2(r.dew_point_c)
        : round2(dewPointC(r.temperature_c, r.humidity_pct)),
      humidity_min: round2(r.humidity_min),
      humidity_max: round2(r.humidity_max),
      sample_count: r.sample_count,
    }));

  return { bucket: resolved, points, truncated };
}

/** The single most recent reading, with dew point derived if it wasn't stored. */
export function latestReading(db, deviceId) {
  const row = db.prepare(
    `SELECT recorded_at, temperature_c, humidity_pct, dew_point_c
       FROM readings WHERE device_id = ? ORDER BY recorded_at DESC LIMIT 1`,
  ).get(deviceId);
  if (!row) return null;

  return {
    recorded_at: row.recorded_at,
    temperature_c: row.temperature_c,
    humidity_pct: row.humidity_pct,
    dew_point_c: row.dew_point_c ?? round2(dewPointC(row.temperature_c, row.humidity_pct)),
  };
}

/**
 * Stored scores over time, one point per bucket.
 *
 * Each point is the last real score in its bucket, not an average -- a mean of
 * two levels is not a level anything ever was. (SQLite's documented bare-column
 * rule: alongside a bare `max()`, the other bare columns come from that row.)
 */
export function queryRiskHistory(db, deviceId, { from, to, toOp = '<', bucket = '1h', limit = DEFAULT_LIMIT }) {
  const op = upperBound(toOp);
  const rows = db.prepare(
    `SELECT max(computed_at) AS t, score, level
       FROM risk_scores
      WHERE device_id = $id AND computed_at >= $from AND computed_at ${op} $to
      GROUP BY CAST(strftime('%s', computed_at) AS INTEGER) / $width * $width
      ORDER BY t DESC LIMIT $limit`,
  ).all({
    id: deviceId, from: from.toISOString(), to: to.toISOString(),
    limit: limit + 1, width: BigInt(BUCKETS[bucket]),   // integer division; see queryReadings
  });

  const truncated = rows.length > limit;
  const kept = (truncated ? rows.slice(0, limit) : rows).reverse();

  return { points: kept.map((r) => ({ t: r.t, score: r.score, level: r.level })), truncated };
}
