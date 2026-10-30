// Response schemas are the cheap safety net: Fastify serialises strictly from
// them, so a field that isn't listed here (a password hash, a device key) cannot
// leak out of a route by accident, and the documented shape is enforced once
// instead of re-asserted in every test.

export const userObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    display_name: { type: 'string' },
    is_admin: { type: 'boolean' },
    theme: { type: 'string' },
    device_count: { type: 'integer' },
    created_at: { type: 'string' },
  },
};

export const tokenBundle = {
  type: 'object',
  properties: {
    user: userObject,
    access_token: { type: 'string' },
    refresh_token: { type: 'string' },
    expires_in: { type: 'integer' },
  },
};

const latestReading = (withDewPoint) => ({
  type: ['object', 'null'],
  properties: {
    recorded_at: { type: 'string' },
    temperature_c: { type: 'number' },
    humidity_pct: { type: 'number' },
    ...(withDewPoint ? { dew_point_c: { type: ['number', 'null'] } } : {}),
  },
});

export const deviceListItem = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    location: { type: ['string', 'null'] },
    online: { type: 'boolean' },
    last_seen_at: { type: ['string', 'null'] },
    latest_reading: latestReading(false),
    risk: {
      type: ['object', 'null'],
      properties: { score: { type: 'integer' }, level: { type: 'string' } },
    },
  },
};

export const deviceDetail = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    location: { type: ['string', 'null'] },
    surface_material: { type: 'string' },
    online: { type: 'boolean' },
    last_seen_at: { type: ['string', 'null'] },
    firmware_version: { type: ['string', 'null'] },
    reading_count: { type: 'integer' },
    first_reading_at: { type: ['string', 'null'] },
    latest_reading: latestReading(true),
    risk: {
      type: ['object', 'null'],
      properties: {
        score: { type: 'integer' },
        level: { type: 'string' },
        recommendation: { type: ['string', 'null'] },
        computed_at: { type: 'string' },
      },
    },
    created_at: { type: 'string' },
  },
};

export const errorResponse = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
};

export const surfaceMaterials = ['drywall', 'wood', 'concrete', 'masonry', 'tile', 'unknown'];

// --- Section 3: readings and risk --------------------------------------------

export const readingsResponse = {
  type: 'object',
  properties: {
    device_id: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    bucket: { type: 'string' },
    truncated: { type: 'boolean' },
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          t: { type: 'string' },
          temperature_c: { type: 'number' },
          humidity_pct: { type: 'number' },
          dew_point_c: { type: ['number', 'null'] },
          // Absent on `bucket=raw`; a raw point is its own extreme.
          humidity_min: { type: 'number' },
          humidity_max: { type: 'number' },
          sample_count: { type: 'integer' },
        },
      },
    },
  },
};

const riskFactors = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      label: { type: 'string' },
      contribution: { type: 'integer' },
      detail: { type: 'string' },
      // The quantity behind `detail`, where the factor has one. Present so a
      // client can write the sentence in the reader's own units instead of
      // repeating a Celsius figure this server chose.
      value_c: { type: 'number' },
    },
  },
};

export const riskResponse = {
  type: 'object',
  properties: {
    device_id: { type: 'string' },
    score: { type: 'integer' },
    level: { type: 'string' },
    recommendation: { type: ['string', 'null'] },
    computed_at: { type: 'string' },
    model: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        version: { type: 'string' },
        surface_material: { type: 'string' },
      },
    },
    factors: riskFactors,
    window_hours: { type: 'integer' },
  },
};

/** Not enough history is a legitimate answer, so every risk field goes null. */
export const nullableRiskResponse = {
  type: 'object',
  properties: {
    ...riskResponse.properties,
    score: { type: ['integer', 'null'] },
    level: { type: ['string', 'null'] },
    computed_at: { type: ['string', 'null'] },
    model: { type: ['object', 'null'], properties: riskResponse.properties.model.properties },
    factors: { type: ['array', 'null'], items: riskFactors.items },
    window_hours: { type: ['integer', 'null'] },
  },
};

export const latestResponse = {
  type: 'object',
  properties: {
    device_id: { type: 'string' },
    online: { type: 'boolean' },
    reading: {
      type: ['object', 'null'],
      properties: {
        recorded_at: { type: 'string' },
        temperature_c: { type: 'number' },
        humidity_pct: { type: 'number' },
        dew_point_c: { type: ['number', 'null'] },
      },
    },
    risk: {
      type: ['object', 'null'],
      properties: {
        score: { type: 'integer' },
        level: { type: 'string' },
        recommendation: { type: ['string', 'null'] },
      },
    },
  },
};

export const riskHistoryResponse = {
  type: 'object',
  properties: {
    device_id: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    bucket: { type: 'string' },
    truncated: { type: 'boolean' },
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          t: { type: 'string' },
          score: { type: 'integer' },
          level: { type: 'string' },
        },
      },
    },
  },
};

// --- Section 4: device-facing -------------------------------------------------

export const ingestResponse = {
  type: 'object',
  properties: {
    accepted: { type: 'integer' },
    duplicates: { type: 'integer' },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, reason: { type: 'string' } },
      },
    },
    last_recorded_at: { type: ['string', 'null'] },
    server_time: { type: 'string' },
    config_version: { type: 'integer' },
  },
};

export const heartbeatResponse = {
  type: 'object',
  properties: {
    server_time: { type: 'string' },
    config_version: { type: 'integer' },
  },
};

export const deviceConfigResponse = {
  type: 'object',
  properties: {
    config_version: { type: 'integer' },
    sample_interval_s: { type: 'integer' },
    upload_interval_s: { type: 'integer' },
    heartbeat_interval_s: { type: 'integer' },
    led_enabled: { type: 'boolean' },
  },
};

/** Up-to-date answers with `update_available` alone; the rest serialise away. */
export const firmwareResponse = {
  type: 'object',
  properties: {
    update_available: { type: 'boolean' },
    version: { type: 'string' },
    url: { type: 'string' },
    size_bytes: { type: 'integer' },
    sha256: { type: 'string' },
    mandatory: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  },
};

// --- Section 5: notifications -------------------------------------------------

export const pushTokenResponse = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    platform: { type: 'string' },
    created_at: { type: 'string' },
  },
};

export const preferencesResponse = {
  type: 'object',
  properties: {
    risk_high: { type: 'boolean' },
    risk_critical: { type: 'boolean' },
    device_offline: { type: 'boolean' },
    device_recovered: { type: 'boolean' },
    daily_summary: { type: 'boolean' },
    daily_summary_hour: { type: 'integer' },
    timezone: { type: 'string' },
    quiet_hours: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        start_hour: { type: 'integer' },
        end_hour: { type: 'integer' },
      },
    },
  },
};

export const alertsResponse = {
  type: 'object',
  properties: {
    alerts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          device_id: { type: ['string', 'null'] },
          device_name: { type: ['string', 'null'] },
          type: { type: 'string' },
          fired_at: { type: 'string' },
          score: { type: ['integer', 'null'] },
          level: { type: ['string', 'null'] },
          message: { type: 'string' },
          notified: { type: 'boolean' },
          acknowledged_at: { type: ['string', 'null'] },
        },
      },
    },
    next_cursor: { type: ['string', 'null'] },
  },
};

// --- Section 6: admin ---------------------------------------------------------

export const adminStatsResponse = {
  type: 'object',
  properties: {
    users: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        created_last_7d: { type: 'integer' },
      },
    },
    devices: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        online: { type: 'integer' },
        claimed: { type: 'integer' },
        unclaimed: { type: 'integer' },
      },
    },
    readings: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        last_24h: { type: 'integer' },
      },
    },
    alerts: {
      type: 'object',
      properties: { last_24h: { type: 'integer' } },
    },
    generated_at: { type: 'string' },
  },
};

export const adminDevicesResponse = {
  type: 'object',
  properties: {
    devices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: ['string', 'null'] },      // null while unclaimed
          owner_email: { type: ['string', 'null'] },
          online: { type: 'boolean' },
          last_seen_at: { type: ['string', 'null'] },
          firmware_version: { type: ['string', 'null'] },
          reading_count: { type: 'integer' },
          storage_free_pct: { type: ['number', 'null'] },
          wifi_rssi: { type: ['integer', 'null'] },
          last_error: { type: ['string', 'null'] },
        },
      },
    },
    next_cursor: { type: ['string', 'null'] },
  },
};

/** No `password_hash`, no tokens: the omission is enforced here, once. */
export const adminUsersResponse = {
  type: 'object',
  properties: {
    users: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
          display_name: { type: 'string' },
          is_admin: { type: 'boolean' },
          device_count: { type: 'integer' },
          created_at: { type: 'string' },
          last_login_at: { type: ['string', 'null'] },
        },
      },
    },
    next_cursor: { type: ['string', 'null'] },
  },
};

/**
 * One schema for both audiences. Everything past `status` is optional, so the
 * anonymous answer serialises down to `{"status":"ok"}` on its own -- there is
 * no second shape to keep in step with this one.
 */
export const adminHealthResponse = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string' },
    uptime_s: { type: 'integer' },
    version: { type: 'string' },
    database: {
      type: 'object',
      properties: {
        reachable: { type: 'boolean' },
        size_bytes: { type: 'integer' },
        wal_bytes: { type: 'integer' },
      },
    },
    ingest: {
      type: 'object',
      properties: {
        last_reading_at: { type: ['string', 'null'] },
        readings_last_hour: { type: 'integer' },
      },
    },
  },
};
