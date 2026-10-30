import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, claimDevice, deviceAuth, makeApp, registerUser, setPreferences, storedAlerts,
} from './helpers.js';
import { createPushSender, payloadFor } from '../src/lib/push.js';

const NOW = '2026-09-09T14:00:00.000Z';
const MINUTE = 60_000;

/** A transport that keeps what it was asked to send instead of sending it. */
function spyTransport({ reply = () => ({ ok: true }) } = {}) {
  const sent = [];
  return {
    sent,
    async send(token, payload) {
      sent.push({ token, payload });
      return reply(token, payload);
    },
  };
}

/**
 * A server whose pushes go into an array.
 *
 * The sender is the real one -- only the wire is faked -- so these tests cover
 * the part that decides who gets told, which is the part that has to agree with
 * the settings screen.
 */
async function withPush(t, { transport = spyTransport(), at = NOW } = {}) {
  const push = createPushSender({ transport });
  const { app, db, clock } = makeApp(t, { at, push });
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });

  /** Register a phone, the way the app does on every launch. */
  const registerPhone = async (token, platform = 'ios') => {
    const res = await app.inject({
      method: 'POST', url: api('/push/tokens'), headers: user.auth,
      payload: { token, platform },
    });
    assert.equal(res.statusCode, 201, `token registration failed: ${res.body}`);
  };

  /** Wet readings, enough of them to push a drywall sensor into the red. */
  const soak = async (count = 12, humidity_pct = 96) => {
    const end = clock.now().getTime();
    const readings = Array.from({ length: count }, (_, i) => ({
      recorded_at: new Date(end - (count - 1 - i) * MINUTE).toISOString(),
      temperature_c: 14.5,
      humidity_pct,
    }));
    const res = await app.inject({
      method: 'POST', url: api('/ingest/readings'), headers: deviceAuth(device.key),
      payload: { device_id: device.id, readings },
    });
    assert.equal(res.statusCode, 200, `upload failed: ${res.body}`);
    await push.drain();
  };

  return { app, db, clock, user, device, push, registerPhone, soak, transport };
}

test('an alert worth recording is also a push', async (t) => {
  const { user, db, registerPhone, soak, transport } = await withPush(t);
  await registerPhone('phone-token-1');

  await soak();

  const alerts = storedAlerts(db, user.user.id);
  assert.equal(alerts.length, 1);
  assert.equal(transport.sent.length, 1);

  const { token, payload } = transport.sent[0];
  assert.equal(token, 'phone-token-1');
  // The body is the alert's own sentence, so the lock screen and the alerts
  // list can never describe the same event differently.
  assert.equal(payload.aps.alert.body, alerts[0].message);
  assert.equal(payload.alert_id, alerts[0].id);
  assert.equal(payload.device_id, alerts[0].device_id);
});

test('every phone on the account is told, and only the iOS ones', async (t) => {
  const { registerPhone, soak, transport } = await withPush(t);
  await registerPhone('iphone-a');
  await registerPhone('iphone-b');
  await registerPhone('pixel', 'android');

  await soak();

  assert.deepEqual(transport.sent.map((s) => s.token).sort(), ['iphone-a', 'iphone-b']);
});

test('a phone that was never registered gets nothing, and nothing breaks', async (t) => {
  const { db, user, soak, transport } = await withPush(t);

  await soak();

  assert.equal(storedAlerts(db, user.user.id).length, 1, 'the alert is still recorded');
  assert.equal(transport.sent.length, 0);
});

test('a preference that is off produces neither an alert nor a push', async (t) => {
  const { app, db, user, registerPhone, soak, transport } = await withPush(t);
  await registerPhone('phone-token-1');
  await setPreferences(app, user, { risk_high: false, risk_critical: false });

  await soak();

  assert.equal(storedAlerts(db, user.user.id).length, 0);
  assert.equal(transport.sent.length, 0);
});

test('quiet hours keep the alert and drop the push', async (t) => {
  // 14:00 UTC, inside a window that runs 09:00 to 17:00.
  const { app, db, user, registerPhone, soak, transport } = await withPush(t);
  await registerPhone('phone-token-1');
  await setPreferences(app, user, {
    // High risk only: critical ignores quiet hours by design, and this test is
    // about the types that respect them.
    risk_critical: false,
    quiet_hours: { enabled: true, start_hour: 9, end_hour: 17 },
  });

  await soak(12, 78);

  const alerts = storedAlerts(db, user.user.id);
  assert.equal(alerts.length, 1, 'the record is kept whatever time it is');
  assert.equal(alerts[0].notified, 0);
  assert.equal(transport.sent.length, 0, 'but the phone stays silent');
});

test('critical risk comes through quiet hours', async (t) => {
  const { app, user, registerPhone, soak, transport } = await withPush(t);
  await registerPhone('phone-token-1');
  await setPreferences(app, user, {
    quiet_hours: { enabled: true, start_hour: 9, end_hour: 17 },
  });

  await soak(30, 99);

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].payload.aps['interruption-level'], 'time-sensitive');
});

test('a token Apple rejects is forgotten', async (t) => {
  const transport = spyTransport({ reply: () => ({ ok: false, forget: true }) });
  const { db, registerPhone, soak } = await withPush(t, { transport });
  await registerPhone('stale-token');

  await soak();

  const left = db.prepare('SELECT count(*) AS n FROM push_tokens').get().n;
  assert.equal(left, 0, 'a dead token is not kept around to fail again');
});

test('the badge counts what has not been looked at', async (t) => {
  const { app, user, registerPhone, soak, transport } = await withPush(t);
  await registerPhone('phone-token-1');

  await soak();
  assert.equal(transport.sent[0].payload.aps.badge, 1);

  // Acknowledge it, then cause another alert: the badge counts one, not two.
  const alerts = await app.inject({ method: 'GET', url: api('/alerts'), headers: user.auth });
  const id = alerts.json().alerts[0].id;
  await app.inject({
    method: 'POST', url: api(`/alerts/${id}/acknowledge`), headers: user.auth,
  });

  await soak(40, 99);
  assert.equal(transport.sent.at(-1).payload.aps.badge, 1);
});

test('a transport with no address sends once, with no phone registered', async (t) => {
  // What the simulator transport is: `simctl push` targets a booted simulator,
  // not a token, and the simulator frequently cannot get a token at all.
  const transport = { addressless: true, sent: [], async send(token, payload) {
    this.sent.push({ token, payload }); return { ok: true };
  } };
  const { soak } = await withPush(t, { transport });

  await soak();

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].token, null);
});

test('the payload names the event rather than repeating the sentence', () => {
  const alert = {
    id: 'a1', device_id: 'd1', type: 'device_offline',
    message: 'Attic hatch has stopped reporting.',
  };
  const payload = payloadFor(alert, { badge: 3 });

  assert.equal(payload.aps.alert.title, 'Sensor went quiet');
  assert.equal(payload.aps.alert.body, alert.message);
  assert.equal(payload.aps.badge, 3);
  // Alerts about one sensor stack together rather than filling the screen.
  assert.equal(payload.aps['thread-id'], 'd1');
  assert.equal(payload.aps['interruption-level'], 'active');
});

test('a server with push switched off still records everything', async (t) => {
  const push = createPushSender({ mode: 'off' });
  const { app, db } = makeApp(t, { push });
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });

  const readings = Array.from({ length: 12 }, (_, i) => ({
    recorded_at: new Date(Date.parse(NOW) - (11 - i) * MINUTE).toISOString(),
    temperature_c: 14.5,
    humidity_pct: 96,
  }));
  const res = await app.inject({
    method: 'POST', url: api('/ingest/readings'), headers: deviceAuth(device.key),
    payload: { device_id: device.id, readings },
  });

  assert.equal(res.statusCode, 200);
  await push.drain();
  assert.equal(storedAlerts(db, user.user.id).length, 1);
});
