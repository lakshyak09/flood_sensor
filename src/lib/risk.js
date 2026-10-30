// The risk model. Pure arithmetic over a window of readings -- no database, no
// clock of its own, no I/O -- so it can be tested by feeding numbers in and
// checking numbers out.
//
// Scoring is cheap enough to run inside a request: it is one pass over at most
// a week of readings for a single device. There is no background job.

export const MODEL = { name: 'vtt', version: '2' };
export const WINDOW_HOURS = 168;

/** Below this there isn't enough history to say anything; `risk` reads null. */
export const MIN_READINGS = 6;

/**
 * How far back the two "right now" factors look.
 *
 * They used to read the single most recent sample, which let one wet reading --
 * a shower, a door opened on a cold morning, a sensor glitch -- carry the score
 * on its own: 47 dry readings and one wet one scored `high` on drywall. That
 * contradicts the whole premise, which is that a single high reading means
 * nothing and sustained conditions mean everything.
 *
 * Three hours is long enough to dilute a momentary spike and short enough to
 * still describe conditions now. Mold episodes last days, so the lag costs
 * nothing that matters.
 *
 * Measured back from the latest reading rather than from `now`, so the window
 * can never come out empty: a device that fell silent yesterday is described by
 * the last three hours it did report, not by its final lone sample.
 */
export const RECENT_HOURS = 3;

/**
 * How readily each surface supports growth.
 *   rh_threshold -- relative humidity at which conditions turn favorable
 *   sensitivity  -- overall susceptibility, scaling the whole score
 * Porous, organic surfaces go first; glazed and mineral ones resist.
 */
export const MATERIALS = {
  drywall:  { rh_threshold: 65, sensitivity: 1.00 },
  wood:     { rh_threshold: 70, sensitivity: 0.95 },
  masonry:  { rh_threshold: 80, sensitivity: 0.65 },
  concrete: { rh_threshold: 80, sensitivity: 0.60 },
  tile:     { rh_threshold: 85, sensitivity: 0.40 },
  unknown:  { rh_threshold: 70, sensitivity: 0.80 },
};

/** Each factor's ceiling. They sum to 100, so a maxed-out score is 100. */
const CEILING = { humidity: 30, dew_point_margin: 30, duration: 40 };

/** Magnus-Tetens. Accurate to ~0.4 °C over the range a room ever sees. */
export function dewPointC(temperatureC, humidityPct) {
  const a = 17.62, b = 243.12;
  const rh = Math.min(Math.max(humidityPct, 0.1), 100);
  const gamma = Math.log(rh / 100) + (a * temperatureC) / (b + temperatureC);
  return (b * gamma) / (a - gamma);
}

const clamp01 = (n) => Math.min(Math.max(n, 0), 1);

const LEVELS = [
  { at: 75, level: 'critical',
    recommendation: 'Condensation is imminent or ongoing. Find the moisture source and dry this area now.' },
  { at: 50, level: 'high',
    recommendation: 'Run a dehumidifier in this room and check for a moisture source.' },
  { at: 25, level: 'moderate',
    recommendation: 'Worth watching. Improve ventilation in this room.' },
  { at: 0, level: 'low',
    recommendation: 'Conditions are dry enough. Nothing to do.' },
];

const levelFor = (score) => LEVELS.find((l) => score >= l.at);

/**
 * Score a device's recent history.
 *
 * @param readings  rows of { recorded_at, temperature_c, humidity_pct, dew_point_c? }
 * @param surfaceMaterial  what the sensor is pointed at
 * @param now  the end of the window
 * @returns null when there isn't enough history, otherwise the full breakdown
 */
export function scoreRisk({ readings, surfaceMaterial = 'unknown', now }) {
  const windowStart = now.getTime() - WINDOW_HOURS * 3_600_000;

  const inWindow = readings
    .filter((r) => {
      const t = new Date(r.recorded_at).getTime();
      return t >= windowStart && t <= now.getTime();
    })
    .sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1));

  if (inWindow.length < MIN_READINGS) return null;

  const material = MATERIALS[surfaceMaterial] ?? MATERIALS.unknown;
  const { rh_threshold: threshold, sensitivity } = material;

  const latest = inWindow[inWindow.length - 1];

  const recentStart = new Date(latest.recorded_at).getTime() - RECENT_HOURS * 3_600_000;
  const recent = inWindow.filter((r) => new Date(r.recorded_at).getTime() >= recentStart);
  const mean = (values) => values.reduce((sum, n) => sum + n, 0) / values.length;

  const humidity = mean(recent.map((r) => r.humidity_pct));

  // Averaged per sample rather than from the mean temperature and the mean dew
  // point, because a sample's own stored dew point is the only thing that knows
  // how cold that surface actually was at that moment.
  const margin = mean(recent.map(
    (r) => r.temperature_c - (r.dew_point_c ?? dewPointC(r.temperature_c, r.humidity_pct)),
  ));

  // 1. How far above this material's threshold have the last few hours been?
  const humidityRatio = clamp01((humidity - threshold) / (100 - threshold));

  // 2. How close is the surface to the temperature at which water condenses?
  //    Within 0 °C is condensation; 10 °C of headroom is comfortable.
  const marginRatio = clamp01((10 - margin) / 10);

  // 3. How much of the window was spent in favorable conditions? Growth is
  //    driven by sustained exposure, which is why this carries the most weight.
  const favorable = inWindow.filter((r) => r.humidity_pct >= threshold).length;
  const favorableRatio = favorable / inWindow.length;

  const spanHours = Math.max(1, Math.round(
    (new Date(latest.recorded_at) - new Date(inWindow[0].recorded_at)) / 3_600_000,
  ));
  const favorableHours = Math.round(favorableRatio * spanHours);

  const contribution = (ceiling, ratio) => Math.round(ceiling * ratio * sensitivity);

  const factors = [
    {
      key: 'humidity',
      label: 'Current humidity',
      contribution: contribution(CEILING.humidity, humidityRatio),
      detail: `${humidity.toFixed(0)}% RH (${RECENT_HOURS}-hour mean), ` + (
        humidity >= threshold
          ? `above the ${threshold}% threshold for ${surfaceMaterial}.`
          : `below the ${threshold}% threshold for ${surfaceMaterial}.`
      ),
    },
    {
      key: 'dew_point_margin',
      label: 'Condensation proximity',
      contribution: contribution(CEILING.dew_point_margin, marginRatio),
      // Celsius, like everything else on the wire. `detail` says the same
      // thing in words for anything that just wants a sentence.
      value_c: Math.round(margin * 10) / 10,
      detail: margin <= 0
        ? 'Surface is at or below the dew point, so condensation is forming.'
        : `Surface is within ${margin.toFixed(1)} °C of the dew point.`,
    },
    {
      key: 'duration',
      label: 'Sustained exposure',
      contribution: contribution(CEILING.duration, favorableRatio),
      detail: `Conditions favorable for growth for ${favorableHours} of the last ${spanHours} hours.`,
    },
  ];

  // Summing the already-rounded contributions is what makes the documented
  // invariant -- contributions add up to the score -- exactly true.
  const score = factors.reduce((sum, f) => sum + f.contribution, 0);
  const { level, recommendation } = levelFor(score);

  return {
    score,
    level,
    recommendation,
    computed_at: now.toISOString(),
    model: { ...MODEL, surface_material: surfaceMaterial },
    factors,
    window_hours: WINDOW_HOURS,
    sample_count: inWindow.length,
  };
}

/**
 * Score a device from what's in the database and store the result.
 *
 * `invalidateHistory` drops previously stored scores first. That is what a
 * surface-material change needs: the old scores describe a different material,
 * so they are wrong rather than merely stale.
 *
 * Returns the new score, or null when there isn't enough history.
 */
export function recomputeRisk(db, device, now, { invalidateHistory = false } = {}) {
  const windowStart = new Date(now.getTime() - WINDOW_HOURS * 3_600_000).toISOString();

  const readings = db.prepare(
    `SELECT recorded_at, temperature_c, humidity_pct, dew_point_c
       FROM readings
      WHERE device_id = ? AND recorded_at >= ?
      ORDER BY recorded_at`,
  ).all(device.id, windowStart);

  if (invalidateHistory) {
    db.prepare('DELETE FROM risk_scores WHERE device_id = ?').run(device.id);
  }

  const result = scoreRisk({
    readings,
    surfaceMaterial: device.surface_material,
    now,
  });
  if (!result) return null;

  db.prepare(
    `INSERT INTO risk_scores
       (device_id, computed_at, score, level, recommendation, factors, model_version, window_hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_id, computed_at) DO UPDATE SET
       score = excluded.score, level = excluded.level,
       recommendation = excluded.recommendation, factors = excluded.factors,
       model_version = excluded.model_version, window_hours = excluded.window_hours`,
  ).run(device.id, result.computed_at, result.score, result.level, result.recommendation,
        JSON.stringify(result.factors), MODEL.version, result.window_hours);

  return result;
}

/**
 * The device's risk right now, recomputing only when it can actually have moved.
 *
 * A stored score is still current when no reading has arrived since it was
 * computed: readings and surface material are the model's only inputs, and a
 * material change invalidates stored scores outright. So the recompute rate is
 * bounded by how fast the sensor reports, not by how often the app polls.
 *
 * Returns null when there isn't enough history to say anything.
 */
export function currentRisk(db, device, now) {
  const stored = db.prepare(
    `SELECT score, level, recommendation, computed_at, factors, model_version, window_hours
       FROM risk_scores WHERE device_id = ? ORDER BY computed_at DESC LIMIT 1`,
  ).get(device.id);

  const latestReadingAt = db.prepare(
    'SELECT max(recorded_at) AS at FROM readings WHERE device_id = ?',
  ).get(device.id)?.at ?? null;

  // Rows written before the breakdown was stored (migration 002) carry '[]';
  // they can't answer `GET /risk`, so they don't count as current.
  const hasBreakdown = stored && stored.factors && stored.factors !== '[]';
  const isFresh = !latestReadingAt || (stored && stored.computed_at >= latestReadingAt);

  // The model itself is the third input. A score produced by an older version
  // describes arithmetic this server no longer performs, so it is wrong rather
  // than merely stale -- the same reasoning that makes a material change
  // invalidate stored scores. Without this, a device that stopped reporting
  // would serve a v1 score forever.
  const isCurrentModel = stored && stored.model_version === MODEL.version;

  if (hasBreakdown && isFresh && isCurrentModel) {
    return {
      score: stored.score,
      level: stored.level,
      recommendation: stored.recommendation,
      computed_at: stored.computed_at,
      model: {
        name: MODEL.name,
        version: stored.model_version,
        surface_material: device.surface_material,
      },
      factors: JSON.parse(stored.factors),
      window_hours: stored.window_hours ?? WINDOW_HOURS,
    };
  }

  return recomputeRisk(db, device, now);
}
