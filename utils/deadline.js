// Submission-deadline parsing, shared by the dashboard countdown (where this
// logic started), the A2 headline strip, and the A4 alert check.
//
// The deadline is NOT a date column. It is free text the analysis extracted
// into analyses.result.summary.submissionDeadline — "June 16, 2026 at 2:00 PM
// EST", "no later than 16 June 2026", or null. Everything here is best-effort
// over that string, which is why every function has a null path: a deadline
// that cannot be read is reported as unknown, never as "today" or "expired".

/**
 * Parses the extracted deadline string into a Date.
 *
 * The time-of-day clause is stripped first because Date() parses "June 16,
 * 2026" reliably and "June 16, 2026 at 2:00 PM EST" much less so.
 *
 * @param {string|null|undefined} deadlineStr
 * @returns {Date|null} null when there is no readable date.
 */
/**
 * Date shapes worth pulling out of a longer phrase, most specific first.
 *
 * The extracted deadline is a sentence as often as it is a date: "July 7, 2026
 * NLT 2:00 P.M. Local Time" is what the reference solicitation actually
 * produces. Stripping a known time clause only helps when the clause matches
 * the one known shape, so this is the fallback — find the date inside the
 * sentence and ignore the rest of it.
 */
const DATE_PATTERNS = [
  // 7 July 2026 / 7 Jul 2026
  /\b(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4})\b/i,
  // July 7, 2026 / Jul 7 2026
  /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/i,
  // 2026-07-07
  /\b(\d{4}-\d{2}-\d{2})\b/,
  // 07/07/2026 or 7-7-2026
  /\b(\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/,
]

/**
 * Parses the extracted deadline string into a Date.
 *
 * Two passes. First the original approach — strip a trailing time clause and
 * let Date() read what is left, which handles the clean cases. When that
 * fails, hunt for a recognisable date anywhere in the string, because the
 * value is free text from a model and frequently carries qualifiers Date()
 * cannot parse ("NLT", "Local Time", "on or before").
 *
 * @param {string|null|undefined} deadlineStr
 * @returns {Date|null} null when there is no readable date.
 */
function parseDeadline(deadlineStr) {
  if (!deadlineStr) return null

  const text = String(deadlineStr)

  const cleaned = text
    .replace(/at\s+\d+:\d+\s*(AM|PM)?\s*(EST|CST|PST|EDT|CDT|PDT|UTC)?/i, '')
    .trim()

  const parsed = new Date(cleaned)

  if (!isNaN(parsed.getTime())) {
    return parsed
  }

  for (const pattern of DATE_PATTERNS) {
    const match = pattern.exec(text)

    if (!match) continue

    const candidate = new Date(match[1].replace(/(\d)(st|nd|rd|th)/i, '$1'))

    if (!isNaN(candidate.getTime())) {
      return candidate
    }
  }

  return null
}

/**
 * Whole days from today until the deadline.
 *
 * Negative means the deadline has passed. Measured from midnight so a deadline
 * later today reads as 0 rather than flickering with the clock.
 *
 * @param {string|null|undefined} deadlineStr
 * @returns {number|null} null when the deadline cannot be read.
 */
function getDaysRemaining(deadlineStr) {
  const deadline = parseDeadline(deadlineStr)

  if (!deadline) return null

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return Math.ceil((deadline - today) / (1000 * 60 * 60 * 24))
}

/**
 * How a countdown should read and how loudly.
 *
 * `tone` is a plain word, not a CSS class — callers map it to their own
 * styling. Keeping Bootstrap out of here is what lets the alert route use this
 * without importing a UI vocabulary it has no use for.
 *
 * @param {string|null|undefined} deadlineStr
 * @returns {{days: number|null, label: string, tone: 'unknown'|'passed'|'urgent'|'soon'|'ok'}}
 */
function describeDeadline(deadlineStr) {
  const days = getDaysRemaining(deadlineStr)

  if (days === null) {
    return {
      days: null,
      label: deadlineStr ? 'Date unreadable' : 'Not stated',
      tone: 'unknown',
    }
  }

  if (days < 0) {
    return {
      days,
      label: `Passed ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`,
      tone: 'passed',
    }
  }

  if (days === 0) return { days, label: 'Due today', tone: 'urgent' }
  if (days <= 3) return { days, label: `${days} day${days === 1 ? '' : 's'} left`, tone: 'urgent' }
  if (days <= 14) return { days, label: `${days} days left`, tone: 'soon' }

  return { days, label: `${days} days left`, tone: 'ok' }
}

module.exports = {
  parseDeadline,
  getDaysRemaining,
  describeDeadline,
}
