// Deterministic date rendering, for anything that can be server-rendered.
//
// WHY THIS EXISTS
//
// `new Date(x).toLocaleString()` asks the machine it runs on how dates should
// look. Next renders each page twice — once on the server, once again in the
// browser during hydration — and those two machines rarely agree, so the same
// value produces two different strings and React reports a hydration mismatch.
//
// There are TWO independent axes, and pinning only the first is a half-fix:
//
//   LOCALE. Measured on this dev machine, whose default is en-PK:
//     toLocaleString()        -> "31/07/2026, 11:02:47 pm"   (server output)
//     toLocaleString('en-US') -> "7/31/2026, 11:02:47 PM"    (en-US browser)
//
//   TIME ZONE. With the locale already pinned to en-US, the same instant is:
//     UTC              -> "7/31/2026, 6:02:47 PM"
//     America/New_York -> "7/31/2026, 2:02:47 PM"
//     Asia/Karachi     -> "7/31/2026, 11:02:47 PM"
//   Vercel runs its functions in UTC and the reader's browser does not, so
//   locale alone still leaves the clock time mismatched — and for a date-only
//   render, the DAY itself flips either side of midnight (2026-08-01T02:30Z is
//   "Aug 1" in UTC and "Jul 31" in Los Angeles).
//
// So both are pinned here: `en-US` and `UTC`. UTC is the only zone every
// machine agrees on without being told, which is the entire requirement. The
// cost is that a timestamp reads in UTC rather than the viewer's local time,
// so `formatDateTime` labels it plainly rather than quietly showing a clock
// time that is wrong for the reader.
//
// The alternative — rendering dates only in a useEffect — was rejected
// deliberately: it trades a console warning for a visible flash of missing
// content on every load, which is worse for the reader and fixes nothing.

/** Shared by every formatter here. Never omit either key. */
const FIXED = {
  locale: 'en-US',
  timeZone: 'UTC',
}

/** What to render when a value is missing or unparseable. */
const FALLBACK = '—'

/**
 * @param {string|number|Date} value
 * @returns {Date|null} null when absent or unparseable.
 */
function toDate(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)

  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Date only, e.g. "Jul 31, 2026".
 *
 * @param {string|number|Date} value
 * @returns {string} FALLBACK when the value cannot be parsed.
 *
 * @example
 * formatDate('2026-07-31T18:02:47Z') // "Jul 31, 2026"
 */
export function formatDate(value) {
  const date = toDate(value)

  if (!date) {
    return FALLBACK
  }

  return date.toLocaleDateString(FIXED.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: FIXED.timeZone,
  })
}

/**
 * Date and time, e.g. "Jul 31, 2026, 18:02 UTC".
 *
 * The zone is in the output on purpose. Pinning to UTC is what makes the
 * string deterministic, and a clock time shown without saying which zone it
 * belongs to is simply wrong for anyone not in it.
 *
 * @param {string|number|Date} value
 * @returns {string} FALLBACK when the value cannot be parsed.
 *
 * @example
 * formatDateTime('2026-07-31T18:02:47Z') // "Jul 31, 2026, 18:02 UTC"
 */
export function formatDateTime(value) {
  const date = toDate(value)

  if (!date) {
    return FALLBACK
  }

  const formatted = date.toLocaleString(FIXED.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    // 24-hour, so there is no AM/PM casing to disagree about either.
    hour12: false,
    timeZone: FIXED.timeZone,
  })

  return `${formatted} UTC`
}

export { FALLBACK as DATE_FALLBACK }
