#!/usr/bin/env node
// Fake data, because the hardware doesn't exist yet.
//
// Provisions a handful of sensors, claims them to a demo account and uploads a
// week of readings through the real ingest endpoint -- so risk scores and alerts
// are produced by the actual server logic rather than written into tables by
// hand. What you see in the app is what the real thing would have produced.
//
//   node scripts/seed-demo.js                 # against http://127.0.0.1:3000
//   node scripts/seed-demo.js --reset         # throw the old sensors away first
//   BASE=http://host:3000 node scripts/seed-demo.js
//
// Without `--reset` a sensor that already exists is left alone, so the script
// is safe to re-run. With it, the demo account's sensors are deleted and built
// again -- which is what you want before a testing pass, because the history is
// written backwards from now and yesterday's seed leaves a day-shaped hole in
// every chart.
//
// The server must already be running, and it writes to the same database.

import { randomUUID, randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { hashToken } from '../src/lib/tokens.js';
import { config } from '../src/config.js';

const RESET = process.argv.includes('--reset');

const BASE = (process.env.BASE ?? 'http://127.0.0.1:3000') + '/api/v1';
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@flood.local';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  }
  return json;
}

/** Register, or sign in if the demo account is already there. */
async function account() {
  try {
    const session = await api('/auth/register', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD, display_name: 'Demo' },
    });
    console.log(`  created account ${EMAIL}`);
    return session;
  } catch (err) {
    if (!String(err.message).includes('email_taken')) throw err;
    const session = await api('/auth/login', {
      method: 'POST', body: { email: EMAIL, password: PASSWORD },
    });
    console.log(`  signed in as ${EMAIL}`);
    return session;
  }
}

/** Manufacturing's job. There is no route for this, by design. */
function provision(db) {
  const id = randomUUID();
  const key = `dk_demo_${randomBytes(12).toString('hex')}`;
  db.prepare('INSERT INTO devices (id, device_key_hash, created_at) VALUES (?, ?, ?)')
    .run(id, hashToken(key), new Date(Date.now() - 30 * DAY).toISOString());
  return { id, key };
}

/**
 * A week of readings for one sensor.
 *
 * Temperature follows a daily cycle -- rooms are coldest before dawn, which is
 * also when the dew point margin is tightest, so the risk model has something
 * real to chew on. Humidity gets a slow trend plus noise, and each profile
 * layers its own story on top.
 */
function generate({ days = 7, everyMinutes = 10, profile, endAt = Date.now() }) {
  const readings = [];
  const count = Math.floor((days * DAY) / (everyMinutes * MINUTE));

  for (let i = count - 1; i >= 0; i -= 1) {
    const at = endAt - i * everyMinutes * MINUTE;
    const hoursFromEnd = (endAt - at) / HOUR;
    const dayPhase = ((at % DAY) / DAY) * Math.PI * 2;

    const { temperature_c, humidity_pct } = profile({ hoursFromEnd, dayPhase, at });

    readings.push({
      recorded_at: new Date(at).toISOString(),
      temperature_c: Math.round(temperature_c * 10) / 10,
      humidity_pct: Math.round(Math.min(100, Math.max(0, humidity_pct)) * 10) / 10,
    });
  }
  return readings;
}

const jitter = (amount) => (Math.random() - 0.5) * 2 * amount;

const PROFILES = {
  // Starts unremarkable, then a moisture source appears three days ago and the
  // humidity climbs and stays up. This is the sensor that should end in the red.
  worsening: ({ hoursFromEnd, dayPhase }) => {
    const base = 17.5 + Math.sin(dayPhase) * 1.8;
    const episode = Math.max(0, (72 - hoursFromEnd) / 72);
    return {
      temperature_c: base + jitter(0.3),
      humidity_pct: 58 + episode * 28 + Math.sin(dayPhase) * -3 + jitter(1.5),
    };
  },

  // A dry, well-ventilated space. Should sit firmly in the green all week.
  dry: ({ dayPhase }) => ({
    temperature_c: 20.5 + Math.sin(dayPhase) * 2.2 + jitter(0.3),
    humidity_pct: 44 + Math.sin(dayPhase) * -4 + jitter(2),
  }),

  // Short sharp spikes twice a day -- someone showering. The whole point of the
  // model is that these do NOT add up to a mold problem, so this one should
  // stay low despite touching 90% regularly.
  spiky: ({ dayPhase, at }) => {
    const hour = new Date(at).getUTCHours();
    const shower = (hour === 7 || hour === 20) ? 32 : 0;
    return {
      temperature_c: 19 + Math.sin(dayPhase) * 1.5 + jitter(0.4),
      humidity_pct: 52 + shower + jitter(2),
    };
  },
};

const SENSORS = [
  { name: 'Basement north wall', location: 'Basement', surface_material: 'drywall',
    profile: 'worsening' },
  { name: 'Crawlspace', location: 'Under the kitchen', surface_material: 'concrete',
    profile: 'dry' },
  { name: 'Bathroom wall', location: 'Upstairs bathroom', surface_material: 'tile',
    profile: 'spiky' },
  // Stopped reporting three hours ago. Opening the app is what makes the server
  // notice, so this one produces an offline alert on the first refresh.
  { name: 'Attic hatch', location: 'Attic', surface_material: 'wood',
    profile: 'dry', silentForHours: 3 },
  // Shipped but never set up: no readings at all. Exercises the empty states,
  // which are easy to get wrong and never seen once there is data.
  { name: 'Garage back corner', location: 'Garage', surface_material: 'masonry',
    profile: 'dry', neverReported: true },
];

async function main() {
  console.log(`Seeding ${BASE}`);

  // Fail early and clearly if the server isn't up.
  try {
    await api('/admin/health');
  } catch {
    console.error(`\nThe server isn't answering at ${BASE}.\n`
      + 'Start it first:  JWT_SECRET=dev-secret npm start\n');
    process.exit(1);
  }

  const session = await account();
  const token = `Bearer ${session.access_token}`;
  const db = openDb(config.databasePath);

  if (RESET) {
    // Straight out of the table rather than through DELETE /devices/:id, which
    // unclaims a device and leaves its rows behind. Nothing on this account
    // should outlive a reset -- including sensors added by hand while testing,
    // which are exactly the debris a clean slate is meant to clear -- and the
    // schema's cascades take the readings, scores and alerts with them.
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL.toLowerCase()).id;
    const rows = db.prepare('SELECT id, name FROM devices WHERE user_id = ?').all(userId);
    for (const row of rows) {
      db.prepare('DELETE FROM alerts WHERE device_id = ?').run(row.id);
      db.prepare('DELETE FROM devices WHERE id = ?').run(row.id);
    }
    console.log(`  reset: removed ${rows.length} sensor(s)`);
  }

  const existing = await api('/devices', { token });
  const known = new Set(existing.devices.map((d) => d.name));

  for (const sensor of SENSORS) {
    if (known.has(sensor.name)) {
      console.log(`  ${sensor.name}: already present, skipping`);
      continue;
    }

    const device = provision(db);
    await api('/devices/claim', {
      method: 'POST', token,
      body: {
        device_id: device.id,
        device_key: device.key,
        name: sensor.name,
        location: sensor.location,
        surface_material: sensor.surface_material,
      },
    });

    if (sensor.neverReported) {
      console.log(`  ${sensor.name}: claimed, no readings`);
      continue;
    }

    const endAt = Date.now() - (sensor.silentForHours ?? 0) * HOUR;
    const readings = generate({ profile: PROFILES[sensor.profile], endAt });

    // The endpoint takes at most 500 per request, which is the device's own
    // constraint -- so the seeder respects it rather than working around it.
    let accepted = 0;
    for (let i = 0; i < readings.length; i += 500) {
      const batch = readings.slice(i, i + 500);
      const result = await api('/ingest/readings', {
        method: 'POST',
        token: `Device ${device.key}`,
        body: { device_id: device.id, firmware_version: '1.4.2', readings: batch },
      });
      accepted += result.accepted;
    }

    // `last_seen_at` is when the device last *spoke*, and it just spoke -- so
    // backdating the readings is not enough to make it look offline. Push the
    // timestamp back directly, which is the only way to fake a sensor that has
    // gone quiet without waiting half an hour for it to happen.
    if (sensor.silentForHours) {
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
        .run(new Date(endAt).toISOString(), device.id);
    }

    const risk = await api(`/devices/${device.id}/risk`, { token });
    const summary = risk.score === null
      ? 'not scored'
      : `score ${risk.score} (${risk.level})`;
    console.log(`  ${sensor.name}: ${accepted} readings, ${summary}`);
  }

  db.close();

  const alerts = await api('/alerts', { token });
  console.log(`\nDone. ${alerts.alerts.length} alert(s) recorded.`);
  console.log(`\nSign in to the app with:\n  ${EMAIL}\n  ${PASSWORD}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
