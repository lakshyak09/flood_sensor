// The operator's view: counts across every account, and enough per-device
// detail to tell "the fleet is fine" from "a firmware build is bricking them".
//
// Nothing here is scoped to a user, which is the whole point and also the
// reason every route that uses it sits behind `authenticateAdmin`.

import { readFileSync, statSync } from 'node:fs';
import { ONLINE_WINDOW_MS } from './devices.js';
import { decodeCursor, paginate } from './pagination.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * DAY_MS;

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const iso = (ms) => new Date(ms).toISOString();
const one = (db, sql, ...args) => Object.values(db.prepare(sql).get(...args))[0];

/**
 * Totals for the operator dashboard.
 *
 * `readings.total` is a full count of the largest table in the schema. That is
 * deliberate and it is the honest cost of the number: an operator asking "how
 * much data do we hold" wants the answer, not an estimate, and this route is
 * called by one person occasionally rather than by every phone. If it ever
 * stops being cheap enough, the fix is a maintained counter, not a guess.
 */
export function adminStats(db, now) {
  const t = now.getTime();
  const onlineSince = iso(t - ONLINE_WINDOW_MS);

  return {
    users: {
      total: one(db, 'SELECT count(*) FROM users'),
      created_last_7d: one(db, 'SELECT count(*) FROM users WHERE created_at >= ?', iso(t - WEEK_MS)),
    },
    devices: {
      total: one(db, 'SELECT count(*) FROM devices'),
      // Online is derived from `last_seen_at` here exactly as it is on the
      // user's home screen. Two definitions of "online" is two dashboards that
      // disagree in front of the person trying to work out what is wrong.
      online: one(db, 'SELECT count(*) FROM devices WHERE last_seen_at >= ?', onlineSince),
      claimed: one(db, 'SELECT count(*) FROM devices WHERE user_id IS NOT NULL'),
      unclaimed: one(db, 'SELECT count(*) FROM devices WHERE user_id IS NULL'),
    },
    readings: {
      total: one(db, 'SELECT count(*) FROM readings'),
      last_24h: one(db, 'SELECT count(*) FROM readings WHERE recorded_at >= ?', iso(t - DAY_MS)),
    },
    alerts: {
      last_24h: one(db, 'SELECT count(*) FROM alerts WHERE fired_at >= ?', iso(t - DAY_MS)),
    },
    generated_at: now.toISOString(),
  };
}

/**
 * Every device, whoever owns it, newest first.
 *
 * Unclaimed devices are included with a null owner. An operator's list that
 * quietly hid them would be useless for the question it exists to answer --
 * "we shipped 500, where are they?" -- and manufacturing stock that never gets
 * claimed is exactly the kind of thing worth seeing.
 *
 * Paged on `(created_at, id)`: a device row's creation time never changes, so
 * the key stays valid however much the fleet moves underneath a scroll.
 */
export function listAdminDevices(db, { online, limit = DEFAULT_LIMIT, cursor } = {}, now) {
  const where = [];
  const args = { limit: limit + 1 };

  // node:sqlite rejects a named parameter the statement never mentions, so
  // every binding here is added by the clause that uses it.
  const onlineSince = iso(now.getTime() - ONLINE_WINDOW_MS);
  if (online !== undefined) {
    args.onlineSince = onlineSince;
    where.push(online
      ? 'd.last_seen_at >= $onlineSince'
      : '(d.last_seen_at IS NULL OR d.last_seen_at < $onlineSince)');
  }

  if (cursor) {
    const { at, id } = decodeCursor(cursor);
    where.push('(d.created_at < $cursorAt OR (d.created_at = $cursorAt AND d.id < $cursorId))');
    args.cursorAt = at;
    args.cursorId = id;
  }

  const rows = db.prepare(
    `SELECT d.id, d.name, d.created_at, d.last_seen_at, d.firmware_version,
            u.email AS owner_email,
            h.storage_free_pct, h.wifi_rssi, h.last_error,
            -- Correlated, so it is paid for the rows on this page and not for
            -- every device in the fleet.
            (SELECT count(*) FROM readings r WHERE r.device_id = d.id) AS reading_count
       FROM devices d
       LEFT JOIN users u ON u.id = d.user_id
       LEFT JOIN device_health h ON h.device_id = d.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $limit`,
  ).all(args);

  const page = paginate(rows, limit, (row) => [row.created_at, row.id]);

  return {
    devices: page.kept.map((row) => ({
      id: row.id,
      name: row.name,
      owner_email: row.owner_email,
      online: row.last_seen_at !== null && row.last_seen_at >= onlineSince,
      last_seen_at: row.last_seen_at,
      firmware_version: row.firmware_version,
      reading_count: row.reading_count,
      storage_free_pct: row.storage_free_pct ?? null,
      wifi_rssi: row.wifi_rssi ?? null,
      last_error: row.last_error ?? null,
    })),
    next_cursor: page.next_cursor,
  };
}

/**
 * Every account, newest first. No password hash and no token ever appears here
 * -- the response schema in schemas.js is what guarantees that, not this
 * function remembering to leave them out.
 */
export function listAdminUsers(db, { limit = DEFAULT_LIMIT, cursor } = {}) {
  const where = [];
  const args = { limit: limit + 1 };

  if (cursor) {
    const { at, id } = decodeCursor(cursor);
    where.push('(u.created_at < $cursorAt OR (u.created_at = $cursorAt AND u.id < $cursorId))');
    args.cursorAt = at;
    args.cursorId = id;
  }

  const rows = db.prepare(
    `SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at, u.last_login_at,
            (SELECT count(*) FROM devices d WHERE d.user_id = u.id) AS device_count
       FROM users u
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT $limit`,
  ).all(args);

  const page = paginate(rows, limit, (row) => [row.created_at, row.id]);

  return {
    users: page.kept.map((row) => ({
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      is_admin: Boolean(row.is_admin),
      device_count: row.device_count,
      created_at: row.created_at,
      last_login_at: row.last_login_at,
    })),
    next_cursor: page.next_cursor,
  };
}

/** Bytes SQLite is holding, straight from the file the connection is using. */
function databaseSize(db) {
  try {
    const pages = one(db, 'PRAGMA page_count');
    const pageSize = one(db, 'PRAGMA page_size');

    // `:memory:` reports an empty path. There is no WAL file to measure, and
    // saying 0 is truer than pretending we could not look.
    const file = db.prepare('PRAGMA database_list').all().find((r) => r.name === 'main')?.file;
    let walBytes = 0;
    if (file) {
      try { walBytes = statSync(`${file}-wal`).size; } catch { walBytes = 0; }
    }

    return { reachable: true, size_bytes: pages * pageSize, wal_bytes: walBytes };
  } catch {
    // A health check that cannot fail is not a health check.
    return { reachable: false, size_bytes: 0, wal_bytes: 0 };
  }
}

/**
 * Liveness for anyone, detail for an operator.
 *
 * The unauthenticated answer is deliberately one word. This is the URL a load
 * balancer polls and the one an attacker probes first, and neither has any
 * business knowing our version, our disk usage or how much traffic we take.
 *
 * There is no `push` block. The spec sketched one, but nothing in this server
 * sends a push yet -- `POST /push/tokens` stores addresses for a sender that
 * does not exist -- so any status it reported would be a hardcoded `true`. A
 * health field that cannot go false is worse than a missing one, because
 * someone will build an alarm on it. It comes back when there is a sender to
 * ask.
 */
export function healthReport(db, { now, startedAt, detailed }) {
  if (!detailed) return { status: 'ok' };

  const t = now.getTime();
  const database = databaseSize(db);

  return {
    status: database.reachable ? 'ok' : 'degraded',
    uptime_s: Math.max(0, Math.floor((t - startedAt.getTime()) / 1000)),
    version: pkg.version,
    database,
    ingest: {
      last_reading_at: one(db, 'SELECT max(recorded_at) FROM readings'),
      readings_last_hour: one(
        db, 'SELECT count(*) FROM readings WHERE recorded_at >= ?', iso(t - HOUR_MS),
      ),
    },
  };
}
