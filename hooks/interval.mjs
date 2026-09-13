// Shared env-interval validation for the capture hooks. A NaN interval would
// permanently suppress a debounced reminder, and 0 / a negative value would
// fire it on every turn — so only a finite, positive number is honored.
export function positiveIntervalOr(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
