import { formatDuration } from "./duration.mjs";

const MINUTE_MS = 60_000;
const MAX_SEARCH_MINUTES = 6 * 366 * 24 * 60;

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7, normalize: (value) => value === 7 ? 0 : value },
];

const CLEAN_CADENCES = [
  [1, "* * * * *"],
  [2, "*/2 * * * *"],
  [3, "*/3 * * * *"],
  [4, "*/4 * * * *"],
  [5, "*/5 * * * *"],
  [6, "*/6 * * * *"],
  [10, "*/10 * * * *"],
  [12, "*/12 * * * *"],
  [15, "*/15 * * * *"],
  [20, "*/20 * * * *"],
  [30, "*/30 * * * *"],
  [60, "0 * * * *"],
  [120, "0 */2 * * *"],
  [180, "0 */3 * * *"],
  [240, "0 */4 * * *"],
  [360, "0 */6 * * *"],
  [480, "0 */8 * * *"],
  [720, "0 */12 * * *"],
  [1_440, "0 0 * * *"],
  [2_880, "0 0 */2 * *"],
  [4_320, "0 0 */3 * *"],
  [5_760, "0 0 */4 * *"],
  [7_200, "0 0 */5 * *"],
  [8_640, "0 0 */6 * *"],
  [10_080, "0 0 * * 0"],
];

function addRange(values, start, end, step, field) {
  if (start < field.min || end > field.max || start > end) {
    throw new Error(`Invalid ${field.name} range ${start}-${end}.`);
  }
  if (!Number.isSafeInteger(step) || step < 1) throw new Error(`Invalid ${field.name} step.`);
  for (let value = start; value <= end; value += step) {
    values.add(field.normalize ? field.normalize(value) : value);
  }
}

function parseField(source, field) {
  const values = new Set();
  for (const part of source.split(",")) {
    const [base, stepSource, ...extra] = part.split("/");
    if (extra.length > 0 || base.length === 0 || stepSource === "") {
      throw new Error(`Invalid ${field.name} field: ${source}.`);
    }
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (base === "*") {
      addRange(values, field.min, field.max, step, field);
      continue;
    }
    const range = /^(\d+)(?:-(\d+))?$/.exec(base);
    if (!range) throw new Error(`Invalid ${field.name} field: ${source}.`);
    const start = Number(range[1]);
    const end = range[2] === undefined ? start : Number(range[2]);
    if (stepSource !== undefined && range[2] === undefined) {
      throw new Error(`A stepped ${field.name} value must use * or a range.`);
    }
    addRange(values, start, end, step, field);
  }
  if (values.size === 0) throw new Error(`Empty ${field.name} field.`);
  return { values, wildcard: source === "*" };
}

export function parseCron(expression) {
  const normalized = String(expression ?? "").trim().split(/\s+/).join(" ");
  const sources = normalized ? normalized.split(" ") : [];
  if (sources.length !== FIELDS.length) {
    throw new Error("Cron must contain exactly five fields: minute hour day-of-month month day-of-week.");
  }
  return {
    expression: normalized,
    fields: sources.map((source, index) => parseField(source, FIELDS[index])),
  };
}

export function normalizeCronExpression(expression) {
  return parseCron(expression).expression;
}

export function cronMatches(parsed, date) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed.fields;
  if (!minute.values.has(date.getMinutes()) || !hour.values.has(date.getHours()) || !month.values.has(date.getMonth() + 1)) {
    return false;
  }
  const monthDayMatches = dayOfMonth.values.has(date.getDate());
  const weekDayMatches = dayOfWeek.values.has(date.getDay());
  if (dayOfMonth.wildcard && dayOfWeek.wildcard) return true;
  if (dayOfMonth.wildcard) return weekDayMatches;
  if (dayOfWeek.wildcard) return monthDayMatches;
  return monthDayMatches || weekDayMatches;
}

export function nextCronTime(expression, afterMs) {
  if (!Number.isFinite(afterMs)) throw new Error("Cron baseline must be a finite timestamp.");
  const parsed = typeof expression === "string" ? parseCron(expression) : expression;
  const candidate = new Date(afterMs);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let checked = 0; checked < MAX_SEARCH_MINUTES; checked += 1) {
    if (cronMatches(parsed, candidate)) return candidate.getTime();
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`Cron has no matching time within six years: ${parsed.expression}.`);
}

export function intervalToCron(requestedMs) {
  if (!Number.isSafeInteger(requestedMs) || requestedMs < 1_000) {
    throw new Error("Cron interval must be at least one second.");
  }
  const requestedMinutes = requestedMs / MINUTE_MS;
  let selected = CLEAN_CADENCES[0];
  let distance = Math.abs(requestedMinutes - selected[0]);
  for (const candidate of CLEAN_CADENCES.slice(1)) {
    const candidateDistance = Math.abs(requestedMinutes - candidate[0]);
    if (candidateDistance < distance || (candidateDistance === distance && candidate[0] > selected[0])) {
      selected = candidate;
      distance = candidateDistance;
    }
  }
  const intervalMs = selected[0] * MINUTE_MS;
  return {
    expression: selected[1],
    intervalMs,
    description: `every ${formatDuration(intervalMs)}`,
    adjusted: intervalMs !== requestedMs,
  };
}
