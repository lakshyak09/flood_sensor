// The one thing in this server that happens without being asked.
//
// Everything else is produced by a request that was going to happen anyway: a
// reading arriving scores the risk, and a screen opening notices what changed.
// That works for every alert except one. Silence is the absence of a request,
// so nothing ever arrives to trigger the discovery that a sensor has stopped
// reporting -- and "your basement sensor died" is exactly the warning that must
// not wait for someone to open the app and ask.
//
// So this exists, deliberately and narrowly: a timer that sweeps for devices
// that have gone quiet. It does not score risk (a reading does that), and it
// does not send summaries (nothing does, yet). It runs in the server process
// rather than inside `buildApp`, so a test still gets an app where nothing
// moves unless the test moves it.

import { tx } from '../db.js';
import { sweepOfflineDevices } from './alerts.js';

export const DEFAULT_INTERVAL_MS = 60_000;

export function startOfflineSweeper({
  db,
  clock,
  push,
  intervalMs = DEFAULT_INTERVAL_MS,
  log = console,
}) {
  /**
   * Only accounts that could possibly have something to find.
   *
   * A device that has never reported has not gone quiet, and one already
   * announced has nothing new to say -- the same two exclusions
   * `sweepOfflineDevices` applies, hoisted here so an idle server with a
   * thousand healthy sensors does nothing but run one cheap query a minute.
   */
  const candidates = db.prepare(
    `SELECT DISTINCT user_id FROM devices
      WHERE user_id IS NOT NULL AND offline_alerted = 0 AND last_seen_at IS NOT NULL`,
  );

  function sweep() {
    const now = clock.now();
    let fired = 0;
    for (const { user_id: userId } of candidates.all()) {
      try {
        tx(db, () => { fired += sweepOfflineDevices(db, userId, now, { push }).length; });
      } catch (err) {
        // One account's failure is not the next account's problem, and a
        // throwing sweep must not take the timer down with it.
        log.error?.({ err, userId }, 'offline sweep failed');
      }
    }
    if (fired > 0) log.info?.({ fired }, 'sensors found quiet');
    return fired;
  }

  const timer = setInterval(sweep, intervalMs);
  // Never a reason to hold the process open: this is upkeep, not work.
  timer.unref();

  return { sweep, stop() { clearInterval(timer); } };
}
