import { readFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { createPushSender } from './lib/push.js';
import { startOfflineSweeper } from './lib/sweeper.js';
import { systemClock } from './clock.js';
import { config, push as pushConfig, assertProductionConfig } from './config.js';

assertProductionConfig();

const db = openDb(config.databasePath);

// The .p8 is read once, here, rather than on every send -- and here is also the
// only place in the server that touches the filesystem for a secret.
const push = createPushSender({
  ...pushConfig,
  key: pushConfig.mode === 'apns' ? readFileSync(pushConfig.keyPath, 'utf8') : undefined,
});

const app = buildApp({ db, push, logger: true });
app.log.info({ mode: push.mode, bundle: pushConfig.bundleId }, 'push delivery');

// A sensor going quiet is the one event no request announces, so it is the one
// thing this process looks for on its own. Without it, a phone that never opens
// the app never learns that the sensor stopped reporting -- which is the whole
// failure the product exists to catch.
const sweeper = startOfflineSweeper({
  db,
  clock: systemClock,
  push,
  intervalMs: Number(process.env.SWEEP_INTERVAL_S ?? 60) * 1000,
  log: app.log,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    sweeper.stop();
    await app.close();
    push.close();
    db.close();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
