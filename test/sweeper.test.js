import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, claimDevice, makeApp, registerUser, setLastSeen, storedAlerts,
} from './helpers.js';
import { startOfflineSweeper } from '../src/lib/sweeper.js';
import { createPushSender } from '../src/lib/push.js';

const NOW = '2026-09-09T14:00:00.000Z';
const MINUTE = 60_000;

function spyTransport() {
  const sent = [];
  return { sent, async send(token, payload) { sent.push({ token, payload }); return { ok: true }; } };
}

/**
 * The sweeper with its timer never started.
 *
 * `sweep()` is called directly so the test controls when it runs -- a test that
 * waits a minute for an interval is a test nobody runs.
 */
function sweeperFor(t, { db, clock, push }) {
  const sweeper = startOfflineSweeper({ db, clock, push, log: { info() {}, error() {} } });
  t.after(() => sweeper.stop());
  return sweeper;
}

test('a sensor that goes quiet is found without anyone opening the app', async (t) => {
  const transport = spyTransport();
  const push = createPushSender({ transport });
  const { app, db, clock } = makeApp(t, { at: NOW, push });
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user);

  await app.inject({
    method: 'POST', url: api('/push/tokens'), headers: user.auth,
    payload: { token: 'a-phone', platform: 'ios' },
  });

  // It reported, then stopped. Nothing else happens: no screen is opened, no
  // reading arrives. This is the case that used to go unnoticed forever.
  setLastSeen(db, device.id, clock.now().toISOString());
  clock.advanceMinutes(45);

  const fired = sweeperFor(t, { db, clock, push }).sweep();
  await push.drain();

  assert.equal(fired, 1);
  const alerts = storedAlerts(db, user.user.id);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'device_offline');
  assert.equal(transport.sent.length, 1, 'and the phone was told');
});

test('the sweep is edge-triggered, not a reminder every minute', async (t) => {
  const push = createPushSender({ transport: spyTransport() });
  const { app, db, clock } = makeApp(t, { at: NOW, push });
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user);

  setLastSeen(db, device.id, clock.now().toISOString());
  clock.advanceMinutes(45);

  const sweeper = sweeperFor(t, { db, clock, push });
  assert.equal(sweeper.sweep(), 1);
  assert.equal(sweeper.sweep(), 0, 'a sensor already announced is not announced again');
  assert.equal(storedAlerts(db, user.user.id).length, 1);
  // Deliveries are scheduled after the commit, so let them finish before the
  // test ends and takes the database with it.
  await push.drain();
});

test('a sensor still reporting, and one that never has, are both left alone', async (t) => {
  const push = createPushSender({ transport: spyTransport() });
  const { app, db, clock } = makeApp(t, { at: NOW, push });
  const user = await registerUser(app);

  const healthy = await claimDevice(app, db, user, { name: 'Healthy' });
  setLastSeen(db, healthy.id, clock.now().toISOString());
  // Claimed and never heard from: still being set up, not a sensor that died.
  await claimDevice(app, db, user, { name: 'Never reported' });

  clock.advance(5 * MINUTE);

  assert.equal(sweeperFor(t, { db, clock, push }).sweep(), 0);
  assert.equal(storedAlerts(db, user.user.id).length, 0);
  await push.drain();
});

test('the sweep respects the preference that switched it off', async (t) => {
  const transport = spyTransport();
  const push = createPushSender({ transport });
  const { app, db, clock } = makeApp(t, { at: NOW, push });
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user);

  await app.inject({
    method: 'PUT', url: api('/notifications/preferences'), headers: user.auth,
    payload: {
      risk_high: true, risk_critical: true,
      device_offline: false, device_recovered: true,
      daily_summary: false, daily_summary_hour: 9, timezone: 'UTC',
      quiet_hours: { enabled: false, start_hour: 22, end_hour: 7 },
    },
  });

  setLastSeen(db, device.id, clock.now().toISOString());
  clock.advanceMinutes(45);

  sweeperFor(t, { db, clock, push }).sweep();
  await push.drain();

  // Nothing recorded and nothing sent -- the same single decision the settings
  // screen describes, reached from a timer instead of from a request.
  assert.equal(storedAlerts(db, user.user.id).length, 0);
  assert.equal(transport.sent.length, 0);
});
