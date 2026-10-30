import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';

// Every timestamp in a token comes from the injected clock, and verification is
// told what "now" is rather than asking the system. That is what lets a test
// jump forward fifteen minutes and watch an access token expire.

const seconds = (date) => Math.floor(date.getTime() / 1000);

export function signAccessToken({ userId, clock, secret = config.jwtSecret }) {
  const iat = seconds(clock.now());
  return jwt.sign(
    { sub: userId, typ: 'access', iat, exp: iat + config.accessTokenTtlS },
    secret,
    { algorithm: 'HS256' },
  );
}

export function signRefreshToken({ userId, clock, secret = config.jwtSecret }) {
  const iat = seconds(clock.now());
  const jti = randomUUID();
  const exp = iat + config.refreshTokenTtlS;
  const token = jwt.sign(
    { sub: userId, typ: 'refresh', jti, iat, exp },
    secret,
    { algorithm: 'HS256' },
  );
  return { token, jti, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Returns the payload, or null for anything malformed, expired or wrong-typed. */
export function verifyToken(token, { typ, clock, secret = config.jwtSecret }) {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      clockTimestamp: seconds(clock.now()),
    });
    return payload.typ === typ ? payload : null;
  } catch {
    return null;
  }
}

/** Refresh tokens are high-entropy already; a fast digest is the right store. */
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
