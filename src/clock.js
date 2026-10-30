export const systemClock = {
  now: () => new Date(),
};

export function fakeClock(start = '2026-09-09T14:00:00.000Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance(ms) { t += ms; return this; },
    advanceSeconds(s) { return this.advance(s * 1_000); },
    advanceMinutes(m) { return this.advance(m * 60_000); },
    advanceHours(h) { return this.advance(h * 3_600_000); },
    advanceDays(d) { return this.advance(d * 86_400_000); },
    set(iso) { t = new Date(iso).getTime(); return this; },
  };
}
