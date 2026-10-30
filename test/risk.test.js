import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRisk, dewPointC, MIN_READINGS, WINDOW_HOURS } from '../src/lib/risk.js';

const NOW = new Date('2026-09-09T14:00:00.000Z');

/** `count` readings, half an hour apart, ending at NOW. */
function history({ count = 12, humidity_pct = 71.2, temperature_c = 17.4, dew_point_c, until = NOW } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    recorded_at: new Date(until.getTime() - (count - 1 - i) * 30 * 60_000).toISOString(),
    temperature_c,
    humidity_pct,
    ...(dew_point_c === undefined ? {} : { dew_point_c }),
  }));
}

const score = (opts = {}) => scoreRisk({
  readings: history(opts.readings ?? {}),
  surfaceMaterial: opts.surfaceMaterial ?? 'drywall',
  now: NOW,
});

test('dew point matches known values', (t) => {
  // 20 °C at 50% RH is about 9.3 °C; saturated air has no spread at all.
  assert.ok(Math.abs(dewPointC(20, 50) - 9.3) < 0.2);
  assert.ok(Math.abs(dewPointC(17.4, 71.2) - 12.1) < 0.3);
  assert.ok(Math.abs(dewPointC(20, 100) - 20) < 0.1);
});

test('too little history scores nothing at all', (t) => {
  assert.equal(score({ readings: { count: MIN_READINGS - 1 } }), null);
  assert.notEqual(score({ readings: { count: MIN_READINGS } }), null);
});

test('readings older than the window do not count', (t) => {
  const stale = history({ count: 20, until: new Date(NOW.getTime() - (WINDOW_HOURS + 1) * 3_600_000) });
  assert.equal(scoreRisk({ readings: stale, surfaceMaterial: 'drywall', now: NOW }), null);
});

test('contributions always add up to the score', (t) => {
  for (const humidity_pct of [30, 55, 66, 71.2, 84, 97]) {
    for (const surfaceMaterial of ['drywall', 'wood', 'concrete', 'masonry', 'tile', 'unknown']) {
      const result = score({ readings: { humidity_pct }, surfaceMaterial });
      const sum = result.factors.reduce((n, f) => n + f.contribution, 0);
      assert.equal(sum, result.score, `${surfaceMaterial} at ${humidity_pct}% RH`);
    }
  }
});

test('dry conditions score low, saturated conditions score critical', (t) => {
  const dry = score({ readings: { humidity_pct: 32, temperature_c: 21 } });
  assert.equal(dry.score, 0);
  assert.equal(dry.level, 'low');

  const wet = score({ readings: { humidity_pct: 99, temperature_c: 12 } });
  assert.equal(wet.level, 'critical');
  assert.ok(wet.score >= 75);
});

test('the same conditions score higher on a more susceptible surface', (t) => {
  const readings = { humidity_pct: 78 };
  const drywall = score({ readings, surfaceMaterial: 'drywall' }).score;
  const wood = score({ readings, surfaceMaterial: 'wood' }).score;
  const concrete = score({ readings, surfaceMaterial: 'concrete' }).score;
  const tile = score({ readings, surfaceMaterial: 'tile' }).score;

  assert.ok(drywall > wood, `drywall ${drywall} should beat wood ${wood}`);
  assert.ok(wood > concrete, `wood ${wood} should beat concrete ${concrete}`);
  assert.ok(concrete > tile, `concrete ${concrete} should beat tile ${tile}`);
});

test('the score carries a usable breakdown', (t) => {
  const result = score({ readings: { humidity_pct: 71.2, temperature_c: 17.4 } });

  assert.deepEqual(result.factors.map((f) => f.key),
                   ['humidity', 'dew_point_margin', 'duration']);
  assert.equal(result.window_hours, 168);
  assert.deepEqual(result.model, { name: 'vtt', version: '2', surface_material: 'drywall' });
  assert.equal(result.computed_at, '2026-09-09T14:00:00.000Z');
  assert.match(result.factors[0].detail,
               /71% RH \(3-hour mean\), above the 65% threshold for drywall/);
  assert.match(result.factors[2].detail, /Conditions favorable for growth for \d+ of the last \d+ hours/);
  assert.ok(result.recommendation.length > 0);
});

test('a stored dew point is used, and a missing one is derived', (t) => {
  const derived = score({ readings: { humidity_pct: 71.2, temperature_c: 17.4 } });
  const stored = score({ readings: { humidity_pct: 71.2, temperature_c: 17.4, dew_point_c: 12.1 } });
  assert.equal(derived.score, stored.score);

  // A surface much colder than the air is at far greater risk, and only the
  // stored dew point can say so.
  const condensing = score({ readings: { humidity_pct: 71.2, temperature_c: 17.4, dew_point_c: 17.4 } });
  assert.ok(condensing.score > stored.score);
  assert.match(condensing.factors[1].detail, /at or below the dew point/);
});

test('the dew point factor carries its number, not just its sentence', (t) => {
  const result = score({ readings: { humidity_pct: 71.2, temperature_c: 17.4 } });
  const margin = result.factors.find((f) => f.key === 'dew_point_margin');

  // A client formatting in Fahrenheit needs the quantity, not the prose the
  // server wrote about it.
  assert.equal(typeof margin.value_c, 'number');
  assert.match(margin.detail, new RegExp(`${margin.value_c}`));

  // The other factors have no temperature in them and say so by omission.
  assert.equal(result.factors.find((f) => f.key === 'humidity').value_c, undefined);
});

test('sustained exposure outweighs a single wet moment', (t) => {
  const base = { temperature_c: 17.4 };
  const readings = [
    ...history({ count: 11, humidity_pct: 40, ...base }),
    { recorded_at: NOW.toISOString(), temperature_c: 17.4, humidity_pct: 90 },
  ];

  const spike = scoreRisk({ readings, surfaceMaterial: 'drywall', now: NOW });
  const sustained = scoreRisk({
    readings: history({ count: 12, humidity_pct: 90, ...base }),
    surfaceMaterial: 'drywall', now: NOW,
  });

  const durationOf = (r) => r.factors.find((f) => f.key === 'duration').contribution;
  assert.ok(durationOf(sustained) > durationOf(spike));
  assert.ok(sustained.score > spike.score);
});

test('one wet reading among dry ones does not move the score much', (t) => {
  // The regression this guards: the two "right now" factors used to read the
  // single latest sample, so 47 dry readings and one wet one scored 50 -- `high`
  // -- and fired an alert. A spike is not an episode.
  const dry = history({ count: 48, humidity_pct: 40, temperature_c: 17.4 });
  const spiked = [
    ...dry.slice(0, 47),
    { recorded_at: dry[47].recorded_at, temperature_c: 17.4, humidity_pct: 92 },
  ];

  const calm = scoreRisk({ readings: dry, surfaceMaterial: 'drywall', now: NOW });
  const spike = scoreRisk({ readings: spiked, surfaceMaterial: 'drywall', now: NOW });

  assert.ok(spike.score < 25,
            `a lone spike scored ${spike.score}; it should stay out of the elevated bands`);
  assert.equal(spike.level, 'low');
  assert.ok(spike.score - calm.score < 10,
            'one sample in three hours should barely move the score');
});

test('a sustained wet spell does reach the elevated bands', (t) => {
  // The other half of the same guarantee: smoothing must not make the model deaf.
  const wet = scoreRisk({
    readings: history({ count: 48, humidity_pct: 92, temperature_c: 17.4 }),
    surfaceMaterial: 'drywall',
    now: NOW,
  });

  assert.equal(wet.level, 'critical');
  assert.ok(wet.score >= 75);
});

test('an unknown material falls back rather than throwing', (t) => {
  const result = scoreRisk({
    readings: history(), surfaceMaterial: 'marzipan', now: NOW,
  });
  assert.equal(result.score, score({ surfaceMaterial: 'unknown' }).score);
});
