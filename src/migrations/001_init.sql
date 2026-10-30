-- Accounts -------------------------------------------------------------------

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,   -- stored lowercased
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  theme          TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark')),
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

-- One row per issued refresh token. Rotation marks the old row revoked rather
-- than deleting it, so re-use of a spent token is detectable.
CREATE TABLE refresh_tokens (
  jti         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- Devices --------------------------------------------------------------------

-- A device row exists from manufacture, unclaimed (user_id IS NULL). Claiming
-- binds it to an account; unclaiming returns it to that state so it can be
-- claimed again by anyone.
CREATE TABLE devices (
  id                TEXT PRIMARY KEY,
  device_key_hash   TEXT NOT NULL UNIQUE,  -- sha256; the key is high-entropy already
  user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  name              TEXT,
  location          TEXT,
  surface_material  TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (surface_material IN
                        ('drywall','wood','concrete','masonry','tile','unknown')),
  firmware_version  TEXT,
  last_seen_at      TEXT,
  config_version    INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  claimed_at        TEXT
);

CREATE INDEX idx_devices_user ON devices(user_id);

-- Readings -------------------------------------------------------------------

-- (device_id, recorded_at) is the natural key: re-sending a reading is a no-op.
CREATE TABLE readings (
  device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  recorded_at    TEXT NOT NULL,
  temperature_c  REAL NOT NULL,
  humidity_pct   REAL NOT NULL,
  dew_point_c    REAL,
  PRIMARY KEY (device_id, recorded_at)
) WITHOUT ROWID;

-- Risk -----------------------------------------------------------------------

CREATE TABLE risk_scores (
  device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  computed_at     TEXT NOT NULL,
  score           INTEGER NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('low','moderate','high','critical')),
  recommendation  TEXT,
  PRIMARY KEY (device_id, computed_at)
);
