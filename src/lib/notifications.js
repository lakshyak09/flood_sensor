// Notification preferences: what a user wants to hear about, and when they do
// not want to be woken up.

import { badRequest } from '../errors.js';

export const PLATFORMS = ['ios', 'android', 'web'];

export const ALERT_TYPES = [
  'risk_high', 'risk_critical', 'device_offline', 'device_recovered', 'daily_summary',
];

/**
 * What a user gets before they have ever opened the settings screen.
 *
 * The two risk alerts and the offline pair are on, because a sensor that says
 * nothing is indistinguishable from a dry room and that is the failure this
 * product exists to prevent. The daily summary is off: a notification every
 * morning that usually says "nothing happened" trains people to ignore the app.
 */
export const DEFAULT_PREFERENCES = {
  risk_high: true,
  risk_critical: true,
  device_offline: true,
  device_recovered: true,
  daily_summary: false,
  daily_summary_hour: 9,
  timezone: 'UTC',
  quiet_hours: { enabled: false, start_hour: 22, end_hour: 7 },
};

const bool = (n) => n === 1;

/** A stored row in the shape the API speaks. */
export function serializePreferences(row) {
  if (!row) return { ...DEFAULT_PREFERENCES, quiet_hours: { ...DEFAULT_PREFERENCES.quiet_hours } };

  return {
    risk_high: bool(row.risk_high),
    risk_critical: bool(row.risk_critical),
    device_offline: bool(row.device_offline),
    device_recovered: bool(row.device_recovered),
    daily_summary: bool(row.daily_summary),
    daily_summary_hour: row.daily_summary_hour,
    timezone: row.timezone,
    quiet_hours: {
      enabled: bool(row.quiet_hours_enabled),
      start_hour: row.quiet_hours_start,
      end_hour: row.quiet_hours_end,
    },
  };
}

export function readPreferences(db, userId) {
  return serializePreferences(
    db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId),
  );
}

/**
 * Reject a timezone the platform can't resolve.
 *
 * There is no list to check against -- the runtime's own tz database is the
 * authority, so ask it. A bad zone stored here would mean quiet hours silently
 * running on UTC for someone who thinks they set them.
 */
export function assertKnownTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw badRequest('validation_failed', `\`${tz}\` is not a known IANA time zone.`);
  }
}

/** The hour of the day, 0-23, as it reads on a wall clock in `timezone`. */
export function localHour(date, timezone) {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', hour12: false,
  }).format(date);
  // Some locales render midnight as "24"; the day starts at 0 everywhere else.
  return Number(hour) % 24;
}

/**
 * Is `at` inside the user's quiet hours?
 *
 * A window that wraps midnight (22 → 7) is the normal case, so the comparison
 * is written for it: start < end is a same-day window, otherwise it's the two
 * ends of the day joined. start === end means a zero-length window, not a
 * silent 24 hours -- nobody sets quiet hours meaning "never notify me".
 */
export function inQuietHours(preferences, at) {
  const { enabled, start_hour: start, end_hour: end } = preferences.quiet_hours;
  if (!enabled || start === end) return false;

  const hour = localHour(at, preferences.timezone);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Preferences say whether an event is worth telling someone about; quiet hours
 * say whether their phone should make a noise about it.
 *
 * `risk_critical` ignores quiet hours on purpose. It means condensation is
 * forming on the surface the sensor is pointed at, and a warning held back
 * until 7am is a warning that arrived after the damage.
 */
export function deliveryFor(preferences, type, at) {
  if (type === 'device_recovered' && !preferences.device_recovered) return null;
  if (type === 'device_offline' && !preferences.device_offline) return null;
  if (type === 'risk_high' && !preferences.risk_high) return null;
  if (type === 'risk_critical' && !preferences.risk_critical) return null;
  if (type === 'daily_summary' && !preferences.daily_summary) return null;

  const silenced = type !== 'risk_critical' && inQuietHours(preferences, at);
  return { notified: !silenced };
}

/** The API's preference object flattened onto the columns that store it. */
export function preferenceColumns(body) {
  return {
    risk_high: body.risk_high ? 1 : 0,
    risk_critical: body.risk_critical ? 1 : 0,
    device_offline: body.device_offline ? 1 : 0,
    device_recovered: body.device_recovered ? 1 : 0,
    daily_summary: body.daily_summary ? 1 : 0,
    daily_summary_hour: body.daily_summary_hour,
    timezone: body.timezone,
    quiet_hours_enabled: body.quiet_hours.enabled ? 1 : 0,
    quiet_hours_start: body.quiet_hours.start_hour,
    quiet_hours_end: body.quiet_hours.end_hour,
  };
}
