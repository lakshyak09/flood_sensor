import {
  DEFAULT_LIMIT, MAX_LIMIT, adminStats, healthReport, listAdminDevices, listAdminUsers,
} from '../lib/admin.js';
import {
  adminDevicesResponse, adminHealthResponse, adminStatsResponse, adminUsersResponse,
  errorResponse,
} from '../schemas.js';

const paging = {
  limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  cursor: { type: 'string' },
};

export default async function adminRoutes(app) {
  // GET /admin/stats ---------------------------------------------------------
  app.get('/admin/stats', {
    preHandler: app.authenticateAdmin,
    schema: { response: { 200: adminStatsResponse, '4xx': errorResponse } },
  }, async () => adminStats(app.db, app.clock.now()));

  // GET /admin/devices -------------------------------------------------------
  app.get('/admin/devices', {
    preHandler: app.authenticateAdmin,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { online: { type: 'boolean' }, ...paging },
      },
      response: { 200: adminDevicesResponse, '4xx': errorResponse },
    },
  }, async (req) => listAdminDevices(app.db, req.query, app.clock.now()));

  // GET /admin/users ---------------------------------------------------------
  app.get('/admin/users', {
    preHandler: app.authenticateAdmin,
    schema: {
      querystring: { type: 'object', additionalProperties: false, properties: paging },
      response: { 200: adminUsersResponse, '4xx': errorResponse },
    },
  }, async (req) => listAdminUsers(app.db, req.query));

  // GET /admin/health --------------------------------------------------------
  // The one route in the API that answers without credentials. It has to: a
  // load balancer has none, and a liveness probe that can 401 is a liveness
  // probe that reports the server down when only its auth is misconfigured.
  app.get('/admin/health', {
    preHandler: app.identifyUser,
    schema: { response: { 200: adminHealthResponse, '4xx': errorResponse } },
  }, async (req) => healthReport(app.db, {
    now: app.clock.now(),
    startedAt: app.startedAt,
    detailed: Boolean(req.user?.is_admin),
  }));
}
