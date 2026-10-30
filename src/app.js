import Fastify from 'fastify';
import { systemClock } from './clock.js';
import { config } from './config.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import deviceRoutes from './routes/devices.js';
import readingRoutes from './routes/readings.js';
import deviceFacingRoutes from './routes/device.js';
import notificationRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';

/**
 * Build the server. Every dependency comes in as an argument -- nothing here
 * reaches out for a database, a clock or an environment variable of its own,
 * and nothing here listens on a port. That is what makes `app.inject()` in a
 * test exercise exactly the same code that production runs.
 */
export function buildApp({
  db,
  clock = systemClock,
  jwtSecret = config.jwtSecret,
  // Where a notification goes once the server has decided to send one. Absent
  // in tests and in a plain `npm start`, which is why every alert path treats
  // it as optional rather than as a dependency it cannot work without.
  push = null,
  logger = false,
} = {}) {
  if (!db) throw new Error('buildApp requires a database');
  if (!jwtSecret) throw new Error('buildApp requires a jwtSecret');

  // Fastify's ajv defaults to `removeAdditional: true`, which quietly deletes
  // any field a schema didn't declare. Every body schema here says
  // `additionalProperties: false`, and it should mean what it says: a client
  // sending a field we don't have -- a typo, or a field from a newer app build
  // -- gets told so. Silently accepting a request and ignoring half of it is
  // the worse failure, because it looks exactly like success.
  const app = Fastify({
    logger,
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.decorate('db', db);
  app.decorate('clock', clock);
  app.decorate('jwtSecret', jwtSecret);
  app.decorate('push', push);
  // Read once, here, so uptime is measured from the same clock everything else
  // uses -- and so a test can advance it and see the number move.
  app.decorate('startedAt', clock.now());

  app.setErrorHandler((err, req, reply) => {
    // Schema failures arrive as Fastify validation errors; everything else we
    // raise ourselves through errors.js.
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'validation_failed', message: err.message },
      });
    }

    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');

    return reply.code(status).send({
      error: {
        code: err.code ?? 'internal_error',
        message: status >= 500 ? 'Something went wrong.' : err.message,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: `No route for ${req.method} ${req.url}.` },
    });
  });

  app.register(authPlugin);
  app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(meRoutes);
    await api.register(deviceRoutes);
    await api.register(readingRoutes);
    await api.register(deviceFacingRoutes);
    await api.register(notificationRoutes);
    await api.register(adminRoutes);
  }, { prefix: '/api/v1' });

  return app;
}
