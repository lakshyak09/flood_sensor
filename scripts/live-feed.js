#!/usr/bin/env node
// A sensor fleet that keeps reporting, for as long as you leave it running.
//
// `seed-demo.js` writes a week of history and stops, which is why the app looks
// like a museum: every reading it can show already happened. This is the other
// half -- it stays up and posts a fresh reading for each sensor every few
// seconds, through the real ingest endpoint, timestamped now. The app's poll
// then has something new to find, charts grow at the right edge, `last_seen_at`
// stays fresh, and risk and alerts move on their own.
//
//   node scripts/live-feed.js                  # every 10s, against a local server
//   node scripts/live-feed.js --interval=5
//   node scripts/live-feed.js --quiet          # no keyboard, for leaving in a tab
//
// Run `seed-demo.js` first: this drives the sensors that script created, and it
// needs history behind them for the risk model to have anything to say.
//
// With a terminal attached it also takes commands -- press `?` for the list --
// so a sensor can be pushed into critical, dried out, or knocked offline while
// you watch the screen you are testing.

import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { hashToken } from '../src/lib/tokens.js';
import { isOnline } from '../src/lib/devices.js';
import { config } from '../src/config.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, v = 'true'] = a.slice(2).split('='); return [k, v]; }),
);

const BASE = (args.base ?? process.env.BASE ?? 'http://127.0.0.1:3000') + '/api/v1';
const EMAIL = args.email ?? process.env.DEMO_EMAIL ?? 'demo@flood.local';
const INTERVAL_S = Number(args.interval ?? 10);

/** The cadence the bridged history is written at -- a plausible sensor, not a firehose. */
const BRIDGE_EVERY_MINUTES = 10;
const INTERACTIVE = args.quiet !== 'true' && process.stdin.isTTY;

// Where the device keys live between runs. A key is only ever stored hashed, so
// once a device is provisioned its key cannot be recovered from the database --
// this file is how the feed keeps talking to the same sensors tomorrow.
const KEYS_PATH = fileURLToPath(new URL('../.live-keys.json', import.meta.url));

// --- the server -------------------------------------------------------------

async function ingest(path, { key, body }) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Device ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// --- devices ----------------------------------------------------------------

function loadKeys() {
  try { return JSON.parse(readFileSync(KEYS_PATH, 'utf8')); } catch { return {}; }
}

/**
 * Give a device a key this process knows.
 *
 * Re-keying in place is the honest way to do this: the old key is unrecoverable
 * and manufacturing is the only thing that ever sets one, so the feed stands in
 * for a factory reflash rather than pretending it found the key somewhere.
 */
function adopt(db, deviceId, keys) {
  if (keys[deviceId]) return keys[deviceId];
  const key = `dk_feed_${randomBytes(16).toString('hex')}`;
  db.prepare('UPDATE devices SET device_key_hash = ? WHERE id = ?')
    .run(hashToken(key), deviceId);
  keys[deviceId] = key;
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  return key;
}

/** The demo account's sensors, each picking up where its history left off. */
function fleet(db, { required = true } = {}) {
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL.toLowerCase());
  const devices = user ? db.prepare(
    'SELECT id, name, surface_material, last_seen_at FROM devices WHERE user_id = ? ORDER BY claimed_at',
  ).all(user.id) : [];

  if (devices.length === 0) {
    // Only fatal at startup. Mid-run this just means a reset is in progress and
    // the new sensors are a second away, so the feed waits rather than dying.
    if (!required) return [];
    console.error(user ? `${EMAIL} has no sensors. Run:  npm run seed\n`
      : `No account ${EMAIL}. Run:  npm run seed\n`);
    process.exit(1);
  }

  // Keys for sensors that no longer exist -- `seed-demo.js --reset` builds new
  // ones with new ids -- are dead weight, and pruning here keeps the file from
  // growing a little every time someone starts over.
  const keys = loadKeys();
  const alive = new Set(devices.map((d) => d.id));
  for (const id of Object.keys(keys)) if (!alive.has(id)) delete keys[id];

  return devices.map((device) => {
    const last = db.prepare(
      `SELECT recorded_at, temperature_c, humidity_pct FROM readings
        WHERE device_id = ? ORDER BY recorded_at DESC LIMIT 1`,
    ).get(device.id);

    return {
      ...device,
      key: adopt(db, device.id, keys),
      lastReadingAt: last ? new Date(last.recorded_at).getTime() : null,
      // A sensor with no history starts somewhere ordinary rather than at zero.
      temperature: last?.temperature_c ?? 19,
      humidity: last?.humidity_pct ?? 55,
      target: { temperature: last?.temperature_c ?? 19, humidity: last?.humidity_pct ?? 55 },
      // Every sensor starts in the state its own data already implies, so
      // starting the feed never quietly repairs a fixture: the seeded sensor
      // that is meant to be offline stays offline, and the one that has never
      // reported still shows the empty state. `r` wakes either of them up.
      reporting: Boolean(last) && isOnline(device.last_seen_at, new Date()),
      uptimeS: 0,
      posted: 0,
    };
  });
}

// --- the signal -------------------------------------------------------------

const jitter = (amount) => (Math.random() - 0.5) * 2 * amount;

/**
 * One step toward wherever the sensor is headed.
 *
 * Readings ease toward the target instead of jumping to it, because a chart
 * that steps between two flat lines looks like a bug in the app. A tenth of the
 * remaining distance per tick settles in a minute or so at the default rate --
 * fast enough to watch, slow enough to look like a room.
 */
function step(device) {
  device.temperature += (device.target.temperature - device.temperature) * 0.1 + jitter(0.15);
  device.humidity += (device.target.humidity - device.humidity) * 0.1 + jitter(0.6);
  device.humidity = Math.min(100, Math.max(0, device.humidity));

  return {
    recorded_at: new Date().toISOString(),
    temperature_c: Math.round(device.temperature * 10) / 10,
    humidity_pct: Math.round(device.humidity * 10) / 10,
  };
}

/**
 * Fill in the time since this sensor last spoke.
 *
 * Seeding writes a week of history backwards from the moment it ran, so a
 * database seeded yesterday has a day-shaped hole in every chart -- and a feed
 * that simply starts posting now leaves it there. A real sensor would have been
 * reporting the whole time, so this makes it true: the gap is filled at the
 * sensor's normal cadence before the live ticks begin, and the history runs
 * unbroken into the readings arriving while you watch.
 */
async function bridgeGap(device) {
  if (!device.reporting || device.lastReadingAt === null) return 0;

  const from = device.lastReadingAt + BRIDGE_EVERY_MINUTES * MINUTE;
  if (from >= Date.now() - BRIDGE_EVERY_MINUTES * MINUTE) return 0;

  // A database left alone for a month does not need a month of invented
  // weather; a week is all any chart in the app can show.
  const start = Math.max(from, Date.now() - 7 * 24 * HOUR);

  const readings = [];
  for (let at = start; at <= Date.now(); at += BRIDGE_EVERY_MINUTES * MINUTE) {
    // The same easing the live tick uses, so the seam is invisible.
    device.temperature += (device.target.temperature - device.temperature) * 0.02 + jitter(0.25);
    device.humidity += (device.target.humidity - device.humidity) * 0.02 + jitter(0.8);
    device.humidity = Math.min(100, Math.max(0, device.humidity));
    readings.push({
      recorded_at: new Date(at).toISOString(),
      temperature_c: Math.round(device.temperature * 10) / 10,
      humidity_pct: Math.round(device.humidity * 10) / 10,
    });
  }

  for (let i = 0; i < readings.length; i += 500) {
    await ingest('/ingest/readings', {
      key: device.key,
      body: { device_id: device.id, firmware_version: '1.4.2', readings: readings.slice(i, i + 500) },
    });
  }
  return readings.length;
}

async function tick(device) {
  if (!device.reporting) return;

  const reading = step(device);
  device.uptimeS += INTERVAL_S;

  try {
    await ingest('/ingest/readings', {
      key: device.key,
      body: { device_id: device.id, firmware_version: '1.4.2', readings: [reading] },
    });
    device.posted += 1;
    device.error = null;
    log(`${device.name}: ${reading.temperature_c} °C, ${reading.humidity_pct}% RH`);
  } catch (err) {
    device.error = String(err.message).slice(0, 120);
    // A key the server no longer recognizes means these sensors were rebuilt
    // underneath us -- `npm run reset` -- so the fleet is re-read rather than
    // every tick failing until someone notices.
    if (/-> 40[134]/.test(device.error)) refleetSoon();
    else log(`${device.name}: ${device.error}`);
  }
}

/**
 * Pick up sensors that were replaced while the feed was running.
 *
 * Debounced, because a reset invalidates every sensor at once and one re-read
 * answers all of them.
 */
let refleetTimer = null;
function refleetSoon() {
  if (refleetTimer) return;
  refleetTimer = setTimeout(() => {
    refleetTimer = null;
    const fresh = fleet(database, { required: false });
    if (fresh.length === 0) return;
    devices = fresh;
    selected = Math.min(selected, devices.length - 1);
    console.log(`\n  sensors were rebuilt, now feeding ${devices.length} of them\n`);
    status();
  }, 2_000);
}

// --- commands ---------------------------------------------------------------

/**
 * Rewrite the recent past.
 *
 * The risk model weighs a three-hour mean and counts favorable readings across
 * a week, so a sensor that starts reporting wet right now takes hours to look
 * any different. Backfilling the conditions means the next score already
 * reflects them -- which is the only way to check a critical screen without
 * scheduling your afternoon around it.
 */
async function backfill(device, { hours, temperature, humidity, everyMinutes = 5 }) {
  const readings = [];
  const end = Date.now();
  for (let at = end - hours * HOUR; at <= end; at += everyMinutes * MINUTE) {
    readings.push({
      recorded_at: new Date(at).toISOString(),
      temperature_c: Math.round((temperature + jitter(0.4)) * 10) / 10,
      humidity_pct: Math.round(Math.min(100, humidity + jitter(1.5)) * 10) / 10,
    });
  }

  // The endpoint's own limit, which the real device is also bound by.
  for (let i = 0; i < readings.length; i += 500) {
    await ingest('/ingest/readings', {
      key: device.key,
      body: { device_id: device.id, firmware_version: '1.4.2', readings: readings.slice(i, i + 500) },
    });
  }

  device.temperature = temperature;
  device.humidity = humidity;
  device.target = { temperature, humidity };
  return readings.length;
}

/**
 * Put text on the Mac's clipboard.
 *
 * The simulator shares it, which is the whole point: a device id and a 56
 * character key are not things anyone should retype into a phone keyboard.
 */
function copy(text) {
  return new Promise((resolve) => {
    const child = spawn('pbcopy');
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

const COMMANDS = {
  n: {
    fleet: true,
    help: 'new sensor: provision one and copy its setup details for the app',
    async run(_device, db) {
      // Exactly what `scripts/provision-device.js` does. Manufacturing's job,
      // and still not a route -- it just happens to be one keypress away now,
      // because adding a sensor is a thing worth testing more than once.
      const id = randomUUID();
      const key = `dk_live_${randomBytes(24).toString('hex')}`;
      db.prepare('INSERT INTO devices (id, device_key_hash, created_at) VALUES (?, ?, ?)')
        .run(id, hashToken(key), new Date().toISOString());

      const copied = await copy(JSON.stringify({ device_id: id, device_key: key }, null, 2));
      return `provisioned\n    ${id}\n    ${key}\n    `
        + (copied
          ? 'copied. In the app: Add sensor, then Paste setup details'
          : 'could not reach the clipboard; type them in by hand');
    },
  },

  w: {
    help: 'wet: 6h of damp air, ends around high  🔔 risk_high',
    async run(device) {
      const n = await backfill(device, { hours: 6, temperature: 16.5, humidity: 88 });
      return `${n} readings backfilled; now reporting damp`;
    },
  },
  W: {
    help: 'soak: 3 days of saturated air, ends critical  🔔 risk_critical',
    async run(device) {
      const n = await backfill(device, { hours: 72, temperature: 14.5, humidity: 97 });
      return `${n} readings backfilled; risk should be critical within a tick`;
    },
  },
  d: {
    help: 'dry: 6h of dry air, clears the recent window',
    async run(device) {
      const n = await backfill(device, { hours: 6, temperature: 21, humidity: 42 });
      return `${n} readings backfilled; drying out`;
    },
  },
  o: {
    help: 'offline: stop reporting  🔔 device_offline, when the app next looks',
    async run(device, db) {
      device.reporting = false;
      // Thirty-one minutes is one minute past the window that makes a device
      // online, so it reads offline on the very next refresh instead of in half
      // an hour. The offline alert fires when the app next looks.
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 31 * MINUTE).toISOString(), device.id);
      return 'gone quiet. Open the app to make the server notice';
    },
  },
  r: {
    help: 'resume: start reporting again  🔔 device_recovered',
    async run(device) {
      device.reporting = true;
      return 'reporting again';
    },
  },
  h: {
    help: 'heartbeat: alive but measuring nothing',
    async run(device) {
      await ingest('/ingest/heartbeat', {
        key: device.key,
        body: {
          device_id: device.id,
          firmware_version: '1.4.2',
          uptime_s: device.uptimeS,
          buffered_readings: 0,
          storage_free_pct: 82.5,
          wifi_rssi: -58 + Math.round(jitter(8)),
        },
      });
      return 'heartbeat sent';
    },
  },
};

// --- the terminal -----------------------------------------------------------

let devices = [];
let database = null;
let selected = 0;         // index into `devices`, or -1 for the whole fleet
let quiet = false;

const label = () => (selected === -1 ? 'all sensors' : devices[selected].name);

function log(line) {
  if (!quiet) console.log(`  ${line}`);
}

function status() {
  console.log('');
  devices.forEach((device, i) => {
    const mark = selected === i ? '>' : ' ';
    const state = device.error ? `!! ${device.error}`
      : device.reporting
        ? `${device.humidity.toFixed(0)}% RH, ${device.temperature.toFixed(1)} °C, ${device.posted} sent`
        : 'quiet';
    console.log(` ${mark} ${i + 1}. ${device.name.padEnd(24)} ${state}`);
  });
  console.log(`\n  selected: ${label()}   ?: help   q: quit\n`);
}

function help() {
  console.log('\n  Commands apply to the selected sensor, except `n`.\n');
  console.log('   1-9  select a sensor');
  console.log('   a    select every sensor at once');
  for (const [key, { help: text }] of Object.entries(COMMANDS)) {
    console.log(`   ${key}    ${text}`);
  }
  console.log('\n   🔔 marks a command that also sends a push notification,');
  console.log('      if the account\'s settings and quiet hours allow it.\n');
  console.log('   s    status');
  console.log('   m    mute/unmute the per-reading log');
  console.log('   q    quit\n');
}

async function handle(key, db) {
  if (key === 'q' || key === '\u0003') { shutdown(db); return; }
  if (key === 's') return status();
  if (key === '?') return help();
  if (key === 'm') { quiet = !quiet; console.log(`\n  log ${quiet ? 'muted' : 'on'}\n`); return; }
  if (key === 'a') { selected = -1; console.log(`\n  selected: all sensors\n`); return; }

  if (/^[1-9]$/.test(key)) {
    const i = Number(key) - 1;
    if (i < devices.length) { selected = i; console.log(`\n  selected: ${devices[i].name}\n`); }
    return;
  }

  const command = COMMANDS[key];
  if (!command) return;

  if (command.fleet) {
    console.log(`\n  ${command.help.split(':')[0]}`);
    try {
      console.log(`    ${await command.run(null, db)}`);
    } catch (err) {
      console.log(`    failed: ${err.message}`);
    }
    console.log('');
    return;
  }

  const targets = selected === -1 ? devices : [devices[selected]];
  console.log(`\n  ${command.help.split(':')[0]}: ${label()}`);
  for (const device of targets) {
    try {
      console.log(`    ${device.name}: ${await command.run(device, db)}`);
    } catch (err) {
      console.log(`    ${device.name}: failed, ${err.message}`);
    }
  }
  console.log('');
}

function shutdown(db) {
  if (INTERACTIVE) process.stdin.setRawMode(false);
  db.close();
  console.log('\nStopped.\n');
  process.exit(0);
}

// --- main -------------------------------------------------------------------

async function main() {
  try {
    const res = await fetch(`${BASE}/admin/health`);
    if (!res.ok) throw new Error();
  } catch {
    console.error(`\nThe server isn't answering at ${BASE}.\n`
      + 'Start it first:  JWT_SECRET=dev-secret npm start\n');
    process.exit(1);
  }

  const db = openDb(config.databasePath);
  database = db;
  devices = fleet(db);

  const live = devices.filter((d) => d.reporting).length;
  console.log(`\nLive feed: ${live} of ${devices.length} sensors reporting, one reading each every ${INTERVAL_S}s`);
  if (live < devices.length) console.log('  the rest were already quiet; `r` wakes one up');
  console.log(`  ${BASE}  as  ${EMAIL}`);

  // Before anything live: make the history reach the present.
  let bridged = 0;
  for (const device of devices) {
    try {
      bridged += await bridgeGap(device);
    } catch (err) {
      console.error(`  ${device.name}: could not backfill, ${err.message}`);
    }
  }
  if (bridged > 0) {
    console.log(`\n  filled ${bridged} reading(s) of catch-up history`);
  }

  status();
  if (INTERACTIVE) help();

  // Ticks are serialised rather than fired on a bare interval: a slow or
  // unreachable server would otherwise stack up requests until something gives.
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { for (const device of devices) await tick(device); } finally { running = false; }
  }, INTERVAL_S * 1000);

  if (INTERACTIVE) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    // A chunk, not a key: fast typing and paste both arrive as several
    // characters at once, and each one is still a command.
    let pending = Promise.resolve();
    process.stdin.on('data', (chunk) => {
      for (const key of chunk) {
        pending = pending.then(() => handle(key, db)).catch(console.error);
      }
    });
  }

  process.on('SIGINT', () => shutdown(db));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
