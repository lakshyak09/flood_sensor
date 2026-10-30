-- The device-facing side: what the sensor is told, what it reports back, and
-- what firmware it should be running.

-- Config the device polls for. Deliberately thin -- timings and the LED. The
-- device's job is to sample, buffer and upload; nothing here is about risk.
-- `config_version` already lives on devices and is what tells the device to
-- re-read this.
ALTER TABLE devices ADD COLUMN sample_interval_s    INTEGER NOT NULL DEFAULT 30;
ALTER TABLE devices ADD COLUMN upload_interval_s    INTEGER NOT NULL DEFAULT 300;
ALTER TABLE devices ADD COLUMN heartbeat_interval_s INTEGER NOT NULL DEFAULT 900;
ALTER TABLE devices ADD COLUMN led_enabled          INTEGER NOT NULL DEFAULT 1;

-- Latest health only, one row per device. A heartbeat every 15 minutes forever
-- is an unbounded table, and nothing reads back further than "how is this
-- device doing right now" -- so this is a current-state row, not a log.
CREATE TABLE device_health (
  device_id         TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  reported_at       TEXT NOT NULL,
  uptime_s          INTEGER,
  buffered_readings INTEGER,
  storage_free_pct  REAL,
  wifi_rssi         INTEGER,
  last_error        TEXT
) WITHOUT ROWID;

-- Published firmware builds. Rows are put here by the release process, the same
-- way device rows are put in devices by manufacturing -- there is no route that
-- creates one.
CREATE TABLE firmware_releases (
  version       TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  mandatory     INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  published_at  TEXT NOT NULL
);

-- Every update attempt, kept as a log: a build that bricks devices is only
-- visible as a pattern across many of them.
CREATE TABLE firmware_reports (
  id            INTEGER PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  reported_at   TEXT NOT NULL,
  from_version  TEXT,
  to_version    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('success','download_failed','verify_failed','flash_failed','rolled_back')),
  error         TEXT
);

CREATE INDEX idx_firmware_reports_device ON firmware_reports(device_id, reported_at);
