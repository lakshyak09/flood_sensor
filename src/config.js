// All environment reading happens here. Nothing else in src/ touches process.env,
// so tests can build an app with explicit config and never depend on the shell.

const isTest = process.env.NODE_ENV === 'test';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databasePath: process.env.DATABASE_PATH ?? './flood.db',

  jwtSecret: process.env.JWT_SECRET ?? (isTest ? 'test-secret-not-for-production' : null),

  accessTokenTtlS: 900,              // 15 minutes, as documented by `expires_in`
  refreshTokenTtlS: 60 * 60 * 24 * 30,

  // Argon2id cost. Deliberately slow in production, deliberately cheap in tests --
  // the same code path, a different knob. Without this a suite that registers a few
  // dozen users spends most of its time hashing.
  argon2: isTest
    ? { memory: 64, passes: 1, parallelism: 1 }
    : { memory: 19456, passes: 2, parallelism: 1 },
};

/**
 * Push delivery.
 *
 * `mode` is worked out rather than demanded: a key on disk means Apple, a
 * bundle id alone means the simulator, and nothing means nothing is sent. The
 * server runs in all three states, because an alert is recorded either way and
 * a laptop with no Apple developer account still has to be able to test the
 * whole flow.
 */
function pushConfig() {
  const keyPath = process.env.APNS_KEY_PATH;
  const bundleId = process.env.APNS_BUNDLE_ID ?? 'dev.flood.app';

  // Simulator delivery is the default rather than something to opt into.
  // Opting in was a trap: `npm start` silently sent nothing, which looks
  // exactly like a bug in the app. Sending to a simulator that isn't running
  // costs one failed subprocess and warns; sending nothing at all costs an
  // afternoon of wondering why.
  const mode = process.env.APNS_MODE
    ?? (keyPath ? 'apns' : isTest ? 'off' : 'simulator');

  return {
    mode,
    keyPath,
    bundleId,
    keyId: process.env.APNS_KEY_ID,
    teamId: process.env.APNS_TEAM_ID,
    // Sandbox is what a development build's tokens are issued against, and
    // sending a debug build's token to production is the most common way this
    // silently never works.
    environment: process.env.APNS_ENV ?? 'sandbox',
  };
}

export const push = pushConfig();

export function assertProductionConfig() {
  if (!config.jwtSecret) throw new Error('JWT_SECRET must be set');

  if (push.mode === 'apns') {
    for (const [name, value] of Object.entries({
      APNS_KEY_PATH: push.keyPath, APNS_KEY_ID: push.keyId,
      APNS_TEAM_ID: push.teamId, APNS_BUNDLE_ID: push.bundleId,
    })) {
      if (!value) throw new Error(`${name} must be set when APNS_MODE=apns`);
    }
  }
}
