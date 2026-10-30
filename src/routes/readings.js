import { ownedDevice, isOnline } from '../lib/devices.js';
import { currentRisk } from '../lib/risk.js';
import {
  BUCKET_NAMES, DEFAULT_LIMIT, MAX_LIMIT,
  latestReading, parseRange, queryReadings, queryRiskHistory,
} from '../lib/readings.js';
import {
  errorResponse, latestResponse, nullableRiskResponse, readingsResponse, riskHistoryResponse,
} from '../schemas.js';

/** Shared by every route here: `from`/`to` are validated in the handler so that
 *  a bad range answers 422 with `invalid_range` rather than a schema 400. */
const rangeQuery = (buckets, defaultBucket) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    bucket: { type: 'string', enum: buckets, default: defaultBucket },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
});

export default async function readingRoutes(app) {
  // GET /devices/:id/readings ------------------------------------------------
  app.get('/devices/:id/readings', {
    preHandler: app.authenticateUser,
    schema: {
      querystring: rangeQuery(BUCKET_NAMES, 'auto'),
      response: { 200: readingsResponse, '4xx': errorResponse },
    },
  }, async (req) => {
    const device = ownedDevice(app.db, req.params.id, req.user.id);
    const { from, to, toOp } = parseRange(req.query, app.clock.now());
    const { bucket, points, truncated } = queryReadings(app.db, device.id, {
      from, to, toOp, bucket: req.query.bucket, limit: req.query.limit,
    });

    return {
      device_id: device.id,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
      truncated,
      points,
    };
  });

  // GET /devices/:id/latest --------------------------------------------------
  app.get('/devices/:id/latest', {
    preHandler: app.authenticateUser,
    schema: { response: { 200: latestResponse, '4xx': errorResponse } },
  }, async (req) => {
    const device = ownedDevice(app.db, req.params.id, req.user.id);
    const now = app.clock.now();
    const risk = currentRisk(app.db, device, now);

    return {
      device_id: device.id,
      online: isOnline(device.last_seen_at, now),
      reading: latestReading(app.db, device.id),
      risk: risk && {
        score: risk.score, level: risk.level, recommendation: risk.recommendation,
      },
    };
  });

  // GET /devices/:id/risk ----------------------------------------------------
  app.get('/devices/:id/risk', {
    preHandler: app.authenticateUser,
    schema: { response: { 200: nullableRiskResponse, '4xx': errorResponse } },
  }, async (req) => {
    const device = ownedDevice(app.db, req.params.id, req.user.id);
    const risk = currentRisk(app.db, device, app.clock.now());

    // A device with too little history isn't a 404 and isn't a zero -- it is a
    // device we can't score yet, and every risk field says so.
    if (!risk) {
      return {
        device_id: device.id,
        score: null, level: null, recommendation: null, computed_at: null,
        model: null, factors: null, window_hours: null,
      };
    }
    const { sample_count, ...body } = risk;
    return { device_id: device.id, ...body };
  });

  // GET /devices/:id/risk/history --------------------------------------------
  app.get('/devices/:id/risk/history', {
    preHandler: app.authenticateUser,
    schema: {
      querystring: rangeQuery(['1h', '1d'], '1h'),
      response: { 200: riskHistoryResponse, '4xx': errorResponse },
    },
  }, async (req) => {
    const device = ownedDevice(app.db, req.params.id, req.user.id);
    // A week by default: the same window the model itself looks back over.
    const { from, to, toOp } = parseRange(req.query, app.clock.now(), { defaultSpanHours: 168 });
    const { points, truncated } = queryRiskHistory(app.db, device.id, {
      from, to, toOp, bucket: req.query.bucket, limit: req.query.limit,
    });

    return {
      device_id: device.id,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: req.query.bucket,
      truncated,
      points,
    };
  });
}
