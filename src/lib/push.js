// Actually reaching the phone.
//
// Everything about *whether* to notify someone already exists: preferences say
// which events matter, quiet hours say whether the phone should make a noise,
// and `alerts.notified` records the answer. This module is only the delivery,
// and it is deliberately downstream of that decision -- it never re-reads a
// preference, so there is exactly one place in the server that decides whether
// a person is disturbed, and the push cannot disagree with the alert list.
//
// Two transports, because the simulator cannot receive a real push:
//
//   apns       HTTP/2 to Apple, signed with a .p8 key. Production.
//   simulator  `xcrun simctl push`, which delivers to a booted simulator.
//              Same payload, same code path, no Apple account.
//   off        Nothing is sent. The alert is still recorded.

import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { connect } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

/** APNs wants a fresh provider token at least hourly; refresh well inside that. */
const TOKEN_TTL_MS = 50 * 60_000;

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/**
 * The notification a phone shows.
 *
 * The title names what happened and the body is the sentence already stored on
 * the alert, so the lock screen and the alerts list cannot drift apart.
 * `alert_id` and `device_id` ride along so a tap can open the sensor it is
 * about rather than the app's front door.
 */
export function payloadFor(alert, { badge = 0 } = {}) {
  return {
    aps: {
      alert: { title: TITLES[alert.type] ?? 'Sensor alert', body: alert.message },
      sound: 'default',
      badge,
      // Critical risk means condensation is forming now. Time Sensitive is what
      // gets it past a Focus, and it is the only type that claims that -- a
      // recovery notice interrupting dinner would teach people to mute the app.
      'interruption-level': alert.type === 'risk_critical' ? 'time-sensitive' : 'active',
      // Alerts about one sensor stack together in Notification Center.
      'thread-id': alert.device_id ?? 'flood',
    },
    alert_id: alert.id,
    device_id: alert.device_id,
    type: alert.type,
  };
}

const TITLES = {
  risk_critical: 'Critical risk',
  risk_high: 'High risk',
  device_offline: 'Sensor went quiet',
  device_recovered: 'Sensor is back',
  daily_summary: 'Daily summary',
};

/** The number on the app icon: alerts this account has not looked at yet. */
function badgeFor(db, userId) {
  return db.prepare(
    'SELECT count(*) AS n FROM alerts WHERE user_id = ? AND acknowledged_at IS NULL',
  ).get(userId)?.n ?? 0;
}

function tokensFor(db, userId) {
  return db.prepare(
    "SELECT token FROM push_tokens WHERE user_id = ? AND platform = 'ios'",
  ).all(userId).map((row) => row.token);
}

/**
 * A token Apple has rejected is dead: the app was deleted, or the token was
 * reissued. Keeping it means every future alert pays for a failed request.
 */
function forget(db, token) {
  db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
}

/**
 * Build the sender the server will use.
 *
 * Always returns something. A server with no push configured gets a sender that
 * records nothing and sends nothing, which is what tests and a bare `npm start`
 * both want -- the alternative is every call site checking for null.
 */
export function createPushSender({ mode = 'off', log = console, transport: injected, ...options } = {}) {
  const transport = injected
    ?? (mode === 'apns' ? apnsTransport({ ...options, log })
      : mode === 'simulator' ? simulatorTransport({ ...options, log })
        : null);

  // Deliveries in flight. Nothing in the server waits on these -- a test does,
  // because the alternative is guessing at a sleep.
  const inFlight = new Set();

  return {
    mode: injected ? (mode === 'off' ? 'injected' : mode) : mode,

    /**
     * Send one alert to every phone the owner has registered.
     *
     * Fire-and-forget on purpose. This is called from inside the transaction
     * that writes the alert, and a slow or unreachable APNs must never hold up
     * a device uploading readings -- nor roll back the alert, which is a real
     * record whether or not a phone was reachable. `setImmediate` also puts the
     * work after the commit, so the badge count it reads includes this alert.
     */
    deliver(db, alert) {
      if (!transport || !alert || alert.notified !== 1) return;

      const delivery = new Promise((resolve) => setImmediate(resolve)).then(async () => {
        try {
          // The simulator transport has no address to send to -- `simctl push`
          // targets whichever simulator is booted -- so it sends once whether
          // or not a phone ever registered. That matters: the simulator often
          // cannot obtain an APNs token at all, and requiring one would make
          // the only testable path the one nobody can test.
          const tokens = transport.addressless ? [null] : tokensFor(db, alert.user_id);
          if (tokens.length === 0) return;

          const payload = payloadFor(alert, { badge: badgeFor(db, alert.user_id) });
          for (const token of tokens) {
            const result = await transport.send(token, payload);
            if (result?.forget) forget(db, token);
            // Logged at info, not debug: "did it actually send?" is the first
            // question anyone asks of a notification that did not arrive.
            log.info?.(
              { type: alert.type, device: alert.device_name, ok: result?.ok === true },
              'push sent',
            );
          }
        } catch (err) {
          // A push that did not arrive is not worth a 500 to whoever happened
          // to trigger it. It is worth a line in the log.
          log.error?.({ err, alert: alert.id }, 'push delivery failed');
        }
      });

      inFlight.add(delivery);
      delivery.finally(() => inFlight.delete(delivery));
    },

    /** Wait for everything currently in flight. For tests, not for routes. */
    async drain() { await Promise.all(inFlight); },

    close() { transport?.close?.(); },
  };
}

// --- APNs ---------------------------------------------------------------------

function apnsTransport({ keyId, teamId, bundleId, key, environment = 'sandbox', log }) {
  const host = HOSTS[environment] ?? HOSTS.sandbox;

  let session = null;
  let token = null;
  let tokenIssuedAt = 0;

  /** ES256 over the team id, which is all APNs asks of a provider. */
  function providerToken() {
    if (token && Date.now() - tokenIssuedAt < TOKEN_TTL_MS) return token;
    token = jwt.sign({ iss: teamId }, key, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: keyId },
    });
    tokenIssuedAt = Date.now();
    return token;
  }

  /** One HTTP/2 session, reconnected if it drops. APNs expects it kept open. */
  function connection() {
    if (session && !session.closed && !session.destroyed) return session;
    session = connect(host);
    session.on('error', (err) => log.error?.({ err }, 'APNs session error'));
    return session;
  }

  return {
    send(deviceToken, payload) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const request = connection().request({
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${providerToken()}`,
          'apns-topic': bundleId,
          'apns-push-type': 'alert',
          // 10 is "deliver now". Everything here is something the owner asked
          // to be told about the moment it happened.
          'apns-priority': '10',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });

        let status = 0;
        let text = '';
        request.on('response', (headers) => { status = headers[':status']; });
        request.on('data', (chunk) => { text += chunk; });
        request.on('error', reject);
        request.on('end', () => {
          if (status === 200) return resolve({ ok: true });

          const reason = safeReason(text);
          // The two ways a token stops being real. Anything else -- a bad key,
          // Apple having a bad day -- is ours to fix, not the token's fault.
          const forgetIt = status === 410 || reason === 'BadDeviceToken';
          log.warn?.({ status, reason }, 'APNs rejected a push');
          resolve({ ok: false, forget: forgetIt, reason });
        });

        request.end(body);
      });
    },

    close() { session?.close(); },
  };
}

function safeReason(text) {
  try { return JSON.parse(text).reason; } catch { return undefined; }
}

// --- Simulator ----------------------------------------------------------------

/**
 * `xcrun simctl push` into the booted simulator.
 *
 * The simulator has no APNs connection, so a real push can never arrive there.
 * This is how a notification is exercised end to end on a laptop with no Apple
 * developer account -- same payload, same decision about who gets it, delivered
 * by the one mechanism the simulator does accept.
 */
function simulatorTransport({ bundleId, log }) {
  return {
    addressless: true,

    async send(_token, payload) {
      const file = join(tmpdir(), `flood-push-${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(payload));
      try {
        await run('xcrun', ['simctl', 'push', 'booted', bundleId, file]);
        return { ok: true };
      } catch (err) {
        // No simulator booted is the normal case when nobody is testing, and
        // it is not an error worth shouting about.
        log.warn?.({ err: err.message }, 'simctl push failed');
        return { ok: false };
      } finally {
        await unlink(file).catch(() => {});
      }
    },
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}
