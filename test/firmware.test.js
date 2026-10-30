import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, claimDevice, deviceAuth, makeApp, registerUser, seedFirmwareRelease,
} from './helpers.js';
import { compareVersions } from '../src/lib/firmware.js';

const NOW = '2026-09-09T14:00:00.000Z';

async function withDevice(t) {
  const { app, db, clock } = makeApp(t, { at: NOW });
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user);

  const check = (current) => app.inject({
    method: 'GET',
    url: api(`/device/firmware${current === undefined ? '' : `?current_version=${current}`}`),
    headers: deviceAuth(device.key),
  });

  const report = (payload, headers = deviceAuth(device.key)) => app.inject({
    method: 'POST', url: api('/device/firmware/report'), headers,
    payload: { device_id: device.id, ...payload },
  });

  const deviceRow = () => db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);

  return { app, db, clock, user, device, check, report, deviceRow };
}

// --- version ordering --------------------------------------------------------

test('versions compare numerically, not as text', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '10 is after 9, though "1" sorts before "9"');
  assert.equal(compareVersions('1.4.2', '1.5.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.5', '1.5.0'), 0, 'a missing part is a zero');
  assert.equal(compareVersions('1.5.1', '1.5'), 1);
});

// --- GET /device/firmware ----------------------------------------------------

test('with nothing published, every device is up to date', async (t) => {
  const { check } = await withDevice(t);
  const res = await check('1.4.2');

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { update_available: false });
});

test('the offered build is the newest published, not merely a newer one', async (t) => {
  const { db, check } = await withDevice(t);
  seedFirmwareRelease(db, { version: '1.5.0' });
  seedFirmwareRelease(db, { version: '1.9.0' });
  seedFirmwareRelease(db, { version: '1.10.0', notes: 'Improved dew point accuracy.' });

  const body = (await check('1.4.2')).json();
  assert.equal(body.update_available, true);
  assert.equal(body.version, '1.10.0');
  assert.equal(body.notes, 'Improved dew point accuracy.');
  assert.equal(body.size_bytes, 1_048_576);
  assert.equal(typeof body.sha256, 'string');
  assert.equal(body.mandatory, false);
});

test('a device already on the newest build is told there is nothing to do', async (t) => {
  const { db, check } = await withDevice(t);
  seedFirmwareRelease(db, { version: '1.5.0' });

  assert.deepEqual((await check('1.5.0')).json(), { update_available: false });
  assert.deepEqual((await check('1.6.0')).json(), { update_available: false });
});

test('a mandatory build the device would skip makes the jump mandatory', async (t) => {
  const { db, check } = await withDevice(t);
  seedFirmwareRelease(db, { version: '1.5.0', mandatory: true, notes: 'Critical fix.' });
  seedFirmwareRelease(db, { version: '1.6.0' });

  const body = (await check('1.4.2')).json();
  assert.equal(body.version, '1.6.0');
  assert.equal(body.mandatory, true, 'the fix is still missing even if it ships inside 1.6.0');

  // A device that already has the mandatory build is under no obligation.
  assert.equal((await check('1.5.0')).json().mandatory, false);
});

test('the check needs a well-formed current_version', async (t) => {
  const { check } = await withDevice(t);

  for (const bad of [undefined, 'v1.4.2', 'latest', '']) {
    const res = await check(bad);
    assert.equal(res.statusCode, 400, String(bad));
    assert.equal(res.json().error.code, 'validation_failed');
  }
});

test('the OTA check is device-authenticated', async (t) => {
  const { app, user } = await withDevice(t);
  const res = await app.inject({
    method: 'GET', url: api('/device/firmware?current_version=1.4.2'), headers: user.auth,
  });
  assert.equal(res.statusCode, 401);
});

// --- POST /device/firmware/report --------------------------------------------

test('a successful flash is what sets the device firmware version', async (t) => {
  const { db, device, report, deviceRow } = await withDevice(t);

  const res = await report({ from_version: '1.4.2', to_version: '1.5.0', status: 'success' });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  assert.equal(deviceRow().firmware_version, '1.5.0');

  const log = db.prepare('SELECT * FROM firmware_reports WHERE device_id = ?').get(device.id);
  assert.equal(log.status, 'success');
  assert.equal(log.from_version, '1.4.2');
  assert.equal(log.reported_at, NOW);
});

test('a failed flash is logged and leaves the device on what it was running', async (t) => {
  const { db, device, report, deviceRow } = await withDevice(t);
  await report({ from_version: '1.4.2', to_version: '1.5.0', status: 'success' });

  const res = await report({
    from_version: '1.5.0', to_version: '1.6.0', status: 'verify_failed',
    error: 'sha256 mismatch',
  });

  assert.equal(res.statusCode, 204);
  assert.equal(deviceRow().firmware_version, '1.5.0');

  const rows = db.prepare(
    'SELECT * FROM firmware_reports WHERE device_id = ? ORDER BY id',
  ).all(device.id);
  assert.equal(rows.length, 2, 'every attempt is kept -- a bad build is a pattern, not an event');
  assert.equal(rows[1].status, 'verify_failed');
  assert.equal(rows[1].error, 'sha256 mismatch');
});

test('every documented outcome is reportable, and nothing else is', async (t) => {
  const { report } = await withDevice(t);

  for (const status of ['success', 'download_failed', 'verify_failed', 'flash_failed', 'rolled_back']) {
    const res = await report({ to_version: '1.5.0', status });
    assert.equal(res.statusCode, 204, status);
  }

  const res = await report({ to_version: '1.5.0', status: 'exploded' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'validation_failed');
});

test('the first flash of a device has no from_version', async (t) => {
  const { db, device, report } = await withDevice(t);
  const res = await report({ to_version: '1.5.0', status: 'success' });

  assert.equal(res.statusCode, 204);
  assert.equal(
    db.prepare('SELECT from_version FROM firmware_reports WHERE device_id = ?')
      .get(device.id).from_version,
    null,
  );
});

test('reporting is device-authenticated', async (t) => {
  const { report, user } = await withDevice(t);
  const res = await report({ to_version: '1.5.0', status: 'success' }, user.auth);
  assert.equal(res.statusCode, 401);
});
