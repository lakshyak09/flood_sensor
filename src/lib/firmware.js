// OTA: deciding what build a device should be running.

/** Dotted numeric, up to four parts. Anything else isn't a version we published. */
export const VERSION_PATTERN = '^[0-9]+(\\.[0-9]+){0,3}$';

export const REPORT_STATUSES = [
  'success', 'download_failed', 'verify_failed', 'flash_failed', 'rolled_back',
];

const parts = (v) => v.split('.').map(Number);

/** -1, 0, 1. Missing trailing parts count as zero, so `1.5` equals `1.5.0`. */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * What to tell a device on `current_version`.
 *
 * Releases are sorted here rather than in SQL because version order is not
 * string order -- `1.10.0` sorts before `1.9.0` as text. The table holds one row
 * per published build, so this is a handful of rows.
 *
 * `mandatory` is true if *any* build the device would be skipping is mandatory,
 * not just the newest one. A device that missed the release with the critical
 * fix must still be told the jump is not optional.
 */
export function firmwareFor(db, currentVersion) {
  const releases = db.prepare('SELECT * FROM firmware_releases').all()
    .sort((a, b) => compareVersions(a.version, b.version));

  const newer = releases.filter((r) => compareVersions(r.version, currentVersion) > 0);
  if (newer.length === 0) return { update_available: false };

  const target = newer[newer.length - 1];
  return {
    update_available: true,
    version: target.version,
    url: target.url,
    size_bytes: target.size_bytes,
    sha256: target.sha256,
    mandatory: newer.some((r) => r.mandatory === 1),
    notes: target.notes,
  };
}
