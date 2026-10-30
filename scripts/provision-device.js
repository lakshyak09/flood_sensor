#!/usr/bin/env node
// Devices exist in the database before anyone claims them -- in production the
// id and key are burned in at manufacture. This stands in for that, so
// POST /devices/claim can be exercised by hand.
//
//   node scripts/provision-device.js [device_id] [--firmware] [--force]
//
// --firmware also writes the id and key into firmware/flood/device_identity.h,
// which is git-ignored and compiled into the sketch -- the real sensor's stand-in
// for a key burned in at the factory. It refuses to replace an existing one
// without --force, because the old key is gone for good once overwritten.

import { existsSync, writeFileSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { hashToken } from '../src/lib/tokens.js';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const toFirmware = args.includes('--firmware');
const force = args.includes('--force');
const id = args.find((a) => !a.startsWith('--')) ?? randomUUID();

const identityPath = new URL('../firmware/flood/device_identity.h', import.meta.url);
if (toFirmware && existsSync(identityPath) && !force) {
  console.error('firmware/flood/device_identity.h already exists. Pass --force to replace it.');
  process.exit(1);
}

const key = `dk_live_${randomBytes(24).toString('hex')}`;

const db = openDb(config.databasePath);
db.prepare(
  'INSERT INTO devices (id, device_key_hash, created_at) VALUES (?, ?, ?)',
).run(id, hashToken(key), new Date().toISOString());
db.close();

console.log(JSON.stringify({ device_id: id, device_key: key }, null, 2));

if (toFirmware) {
  writeFileSync(identityPath, [
    '// Written by `npm run provision:firmware`. Git-ignored: the key is a secret.',
    '#pragma once',
    `#define DEVICE_ID  "${id}"`,
    `#define DEVICE_KEY "${key}"`,
    '',
  ].join('\n'));
  console.log('\nWrote firmware/flood/device_identity.h');
}
if (!toFirmware) console.log('\nThe key is not stored and cannot be recovered. Save it now.');
