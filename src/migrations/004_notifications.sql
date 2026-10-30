-- Notifications: who can be reached, what they want to hear about, and what
-- they were actually told.

-- One row per phone. `token` is unique across accounts, not per account: a
-- phone that signs into a second account must stop receiving the first one's
-- alerts, so re-registering an existing token moves it rather than duplicating.
CREATE TABLE push_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  platform     TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  app_version  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_push_tokens_user ON push_tokens(user_id);

-- Preferences are per account, not per device. A row only exists once someone
-- has saved something; until then the defaults below are what the API reports,
-- which keeps registration from writing rows nobody asked for.
CREATE TABLE notification_preferences (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  risk_high           INTEGER NOT NULL DEFAULT 1,
  risk_critical       INTEGER NOT NULL DEFAULT 1,
  device_offline      INTEGER NOT NULL DEFAULT 1,
  device_recovered    INTEGER NOT NULL DEFAULT 1,
  daily_summary       INTEGER NOT NULL DEFAULT 0,
  daily_summary_hour  INTEGER NOT NULL DEFAULT 9
                        CHECK (daily_summary_hour BETWEEN 0 AND 23),
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
  quiet_hours_start   INTEGER NOT NULL DEFAULT 22 CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end     INTEGER NOT NULL DEFAULT 7  CHECK (quiet_hours_end BETWEEN 0 AND 23),
  updated_at          TEXT
) WITHOUT ROWID;

-- What the user was told. `device_name` is a snapshot rather than a join: the
-- history screen has to keep making sense after a rename, and an alert that
-- silently changes its own wording is not a record of anything.
CREATE TABLE alerts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id        TEXT REFERENCES devices(id) ON DELETE SET NULL,
  device_name      TEXT,
  type             TEXT NOT NULL CHECK (type IN
                     ('risk_high','risk_critical','device_offline',
                      'device_recovered','daily_summary')),
  fired_at         TEXT NOT NULL,
  score            INTEGER,
  level            TEXT,
  message          TEXT NOT NULL,
  -- Whether a push would go out. Quiet hours silence the phone, not the record.
  notified         INTEGER NOT NULL DEFAULT 1,
  acknowledged_at  TEXT
);

-- The listing order, which is also the pagination key: newest first, `id`
-- breaking ties so a cursor can never land in the middle of a same-millisecond
-- pair and skip one.
CREATE INDEX idx_alerts_user ON alerts(user_id, fired_at DESC, id DESC);

-- Alerting is edge-triggered, so the edge has to be remembered somewhere.
--
--   alerted_level   the worst risk level already announced in the current
--                   elevated episode; cleared when the device drops back below
--                   `high`, which is what lets the next spike alert again.
--   offline_alerted whether the user has been told this device went quiet.
ALTER TABLE devices ADD COLUMN alerted_level   TEXT;
ALTER TABLE devices ADD COLUMN offline_alerted INTEGER NOT NULL DEFAULT 0;
