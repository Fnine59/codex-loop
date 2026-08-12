const UNITS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export const MIN_INTERVAL_MS = 1_000;
export const MAX_INTERVAL_MS = 7 * UNITS.d;
export const MAX_LIFETIME_MS = 3_650 * UNITS.d;
export const MIN_DYNAMIC_INTERVAL_MS = UNITS.m;
export const MAX_DYNAMIC_INTERVAL_MS = 6 * UNITS.h;
export const DEFAULT_DYNAMIC_INTERVAL_MS = 30 * UNITS.m;

export function parseDuration(value, { min = MIN_INTERVAL_MS, max = MAX_INTERVAL_MS } = {}) {
  const match = /^(\d+)(s|m|h|d)$/.exec(value ?? "");
  if (!match) throw new Error(`Invalid duration: ${value}. Use forms such as 30s, 5m, 2h, or 1d.`);

  const duration = Number(match[1]) * UNITS[match[2]];
  if (!Number.isSafeInteger(duration) || duration < min || duration > max) {
    throw new Error(`Duration must be between ${formatDuration(min)} and ${formatDuration(max)}.`);
  }
  return duration;
}

export function formatDuration(milliseconds) {
  for (const [unit, size] of Object.entries(UNITS).reverse()) {
    if (milliseconds % size === 0) return `${milliseconds / size}${unit}`;
  }
  return `${Math.ceil(milliseconds / 1_000)}s`;
}
