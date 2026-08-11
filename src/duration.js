const UNITS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(value, { min = 1_000 } = {}) {
  const match = /^(\d+)(s|m|h|d)$/.exec(value ?? "");
  if (!match) {
    throw new Error(`Invalid duration: ${value}. Use forms such as 5m, 2h, or 1d.`);
  }

  const amount = Number(match[1]);
  const duration = amount * UNITS[match[2]];
  if (!Number.isSafeInteger(duration) || duration < min) {
    throw new Error(`Duration must be at least ${formatDuration(min)}.`);
  }
  return duration;
}

export function formatDuration(duration) {
  for (const [unit, size] of Object.entries(UNITS).reverse()) {
    if (duration % size === 0) return `${duration / size}${unit}`;
  }
  return `${Math.ceil(duration / 1_000)}s`;
}
