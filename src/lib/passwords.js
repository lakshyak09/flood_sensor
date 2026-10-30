import { argon2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// Node 26 ships argon2 in core, so there is no native module to build.
// Hashes are stored in the standard PHC string format, which carries the
// parameters with them -- so raising the cost later doesn't invalidate
// existing hashes.

const ALGORITHM = 'argon2id';
const VERSION = 19;
const TAG_LENGTH = 32;
const SALT_LENGTH = 16;

const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '');

function derive(password, salt, { memory, passes, parallelism }) {
  return Buffer.from(argon2Sync(ALGORITHM, {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    parallelism,
    tagLength: TAG_LENGTH,
    memory,
    passes,
  }));
}

export function hashPassword(password, params = config.argon2) {
  const salt = randomBytes(SALT_LENGTH);
  const tag = derive(password, salt, params);
  const { memory, passes, parallelism } = params;
  return `$${ALGORITHM}$v=${VERSION}$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[1] !== ALGORITHM) return false;

  const params = Object.fromEntries(
    parts[3].split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, Number(v)];
    }),
  );
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');

  const actual = derive(password, salt, {
    memory: params.m, passes: params.t, parallelism: params.p,
  });

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
