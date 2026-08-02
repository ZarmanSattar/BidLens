const { supabaseAdmin } = require('../../../lib/supabase/admin')
const { describeDeadline } = require('../../../utils/deadline')

// A4 — deadline and completion alerts, checked ON DEMAND.
//
//   POST application/json
//   {
//     "within_days": 14,        // deadline horizon to alert on
//     "finished_within_hours": 24,  // "your analysis is ready" window
//     "send": false             // false (default) = DRY RUN, nothing is sent
//   }
//
// ZERO TOKEN COST. Table reads, date arithmetic, and — only when explicitly
// asked — one HTTPS call per recipient to an email provider.
//
// DRY RUN BY DEFAULT. `send` must be true AND ALERT_EMAIL_API_KEY must be set
// before anything leaves the machine. Calling this route with no body tells
// you exactly what would go out and to whom, which is the form that is useful
// during development and the only form that is safe to wire to a button.
//
// NOT YET SCHEDULED. Real "as the deadline approaches" delivery needs a timer
// this project does not have yet — Vercel Cron only exists once deployed. The
// route is the half that can be built and tested now; see the notes at the end
// of this file for exactly what deploying adds.
//
// DEDUPLICATED. Every successful send is recorded in notification_log, and an
// alert already present there is skipped rather than re-sent. The identity of
// a notification is (rfp_id, kind, threshold_days) — so the 14-, 7-, 3- and
// 1-day warnings for one RFP each send exactly once, and analysis_complete
// (which carries no threshold) sends once in total.

const DEFAULT_WITHIN_DAYS = 14
const DEFAULT_FINISHED_WITHIN_HOURS = 24

/** Days-remaining thresholds worth interrupting someone for. */
const ALERT_AT_DAYS = [14, 7, 3, 1, 0]

/**
 * The most urgent threshold a deadline has crossed.
 *
 * @param {number} days
 * @returns {number|null}
 */
function thresholdFor(days) {
  const crossed = ALERT_AT_DAYS.filter((threshold) => days <= threshold)

  return crossed.length > 0 ? Math.min(...crossed) : null
}

/**
 * Resolves owner ids to email addresses.
 *
 * Uses the admin auth API, which is the only place the address lives — there
 * is no email column on rfps. A lookup that fails leaves the alert in the
 * result with `email: null`, so a missing address is visible rather than
 * silently dropping the alert.
 *
 * @param {string[]} ownerIds
 * @returns {Promise<Map<string, string|null>>}
 */
async function resolveEmails(ownerIds) {
  const emails = new Map()

  for (const ownerId of [...new Set(ownerIds.filter(Boolean))]) {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(ownerId)

      emails.set(ownerId, error ? null : data?.user?.email || null)
    } catch {
      emails.set(ownerId, null)
    }
  }

  return emails
}

/**
 * Sends one email through the provider's REST API.
 *
 * Deliberately fetch() rather than an SDK: this is one POST, and adding a
 * dependency plus a lockfile change for it is not a trade worth making.
 *
 * @param {{to: string, subject: string, text: string}} message
 * @returns {Promise<{sent: boolean, error: string|null}>}
 */
async function sendEmail(message) {
  const apiKey = process.env.ALERT_EMAIL_API_KEY
  const from = process.env.ALERT_EMAIL_FROM

  if (!apiKey || !from) {
    return {
      sent: false,
      error:
        'ALERT_EMAIL_API_KEY and ALERT_EMAIL_FROM are not set, so nothing was sent.',
    }
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')

      return { sent: false, error: `Provider returned ${response.status}: ${detail.slice(0, 200)}` }
    }

    return { sent: true, error: null }
  } catch (err) {
    return { sent: false, error: err?.message || 'send failed' }
  }
}

/**
 * A threshold as the column stores it: a number, or null for "no step".
 *
 * Null and undefined MUST be handled before the numeric conversion, because
 * `Number(null)` is 0 — a finite number, and a meaningful threshold meaning
 * "due today". Letting null fall through turned a stored null into 0 and made
 * an absent value (NaN) key differently from an explicit null, so the same
 * alert was written one way and looked up another and deduplication silently
 * missed.
 *
 * @param {number|null|undefined} value
 * @returns {number|null}
 */
function normalizeThreshold(value) {
  if (value === null || value === undefined) {
    return null
  }

  const numeric = Number(value)

  return Number.isFinite(numeric) ? numeric : null
}

/**
 * The identity of one notification, matching the unique index exactly.
 *
 * The index is on (rfp_id, kind, coalesce(threshold_days, -1)), so a null
 * threshold — which is what analysis_complete carries, because it fires once
 * rather than at a countdown step — has to collapse to -1 here too. Keying on
 * a raw null instead would make every analysis_complete look distinct and
 * defeat the whole point.
 *
 * @param {{rfp_id: string, kind: string, threshold_days: number|null|undefined}} alert
 * @returns {string}
 */
function notificationKey(alert) {
  return `${alert.rfp_id}|${alert.kind}|${normalizeThreshold(alert.threshold_days) ?? -1}`
}

/**
 * Everything already sent, for the RFPs in this batch.
 *
 * One query rather than one per alert: the batch is bounded by how many RFPs
 * exist, and a per-alert round trip would make a large check slow for no
 * reason.
 *
 * @param {string[]} rfpIds
 * @returns {Promise<{sent: Set<string>, error: string|null}>}
 */
async function loadAlreadySent(rfpIds) {
  if (rfpIds.length === 0) {
    return { sent: new Set(), error: null }
  }

  const { data, error } = await supabaseAdmin
    .from('notification_log')
    .select('rfp_id, kind, threshold_days')
    .in('rfp_id', rfpIds)

  if (error) {
    return { sent: new Set(), error: error.message }
  }

  return {
    sent: new Set((data || []).map((row) => notificationKey(row))),
    error: null,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'POST, GET')

    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}

  const withinDays = Number.isFinite(Number(body.within_days))
    ? Number(body.within_days)
    : DEFAULT_WITHIN_DAYS

  const finishedWithinHours = Number.isFinite(Number(body.finished_within_hours))
    ? Number(body.finished_within_hours)
    : DEFAULT_FINISHED_WITHIN_HOURS

  // Belt and braces: a GET can never send, whatever it asks for.
  const wantsSend = body.send === true && req.method === 'POST'

  try {
    const { data: analyses, error } = await supabaseAdmin
      .from('analyses')
      .select('id, rfp_id, owner_id, result, created_at')
      .order('created_at', { ascending: false })

    if (error) {
      return res.status(500).json({ error: `Could not read analyses: ${error.message}` })
    }

    const rfpIds = [...new Set((analyses || []).map((row) => row.rfp_id).filter(Boolean))]

    const { data: rfps } = await supabaseAdmin
      .from('rfps')
      .select('id, title')
      .in('id', rfpIds.length > 0 ? rfpIds : ['00000000-0000-0000-0000-000000000000'])

    const titles = new Map((rfps || []).map((row) => [row.id, row.title]))

    // One analysis per RFP — the newest. An RFP re-analysed five times should
    // produce one deadline warning, not five.
    const newestByRfp = new Map()

    for (const row of analyses || []) {
      if (!newestByRfp.has(row.rfp_id)) newestByRfp.set(row.rfp_id, row)
    }

    const now = Date.now()
    const alerts = []

    for (const row of newestByRfp.values()) {
      const title = titles.get(row.rfp_id) || 'Untitled RFP'
      const deadlineText = row.result?.summary?.submissionDeadline || null
      const deadline = describeDeadline(deadlineText)

      const ageHours = (now - new Date(row.created_at).getTime()) / 3600000

      // "Your analysis is ready."
      if (ageHours <= finishedWithinHours) {
        alerts.push({
          kind: 'analysis_complete',
          rfp_id: row.rfp_id,
          owner_id: row.owner_id,
          title,
          subject: `BidLens: analysis ready for ${title}`,
          text:
            `The analysis of "${title}" has finished.\n\n` +
            (deadlineText
              ? `Submission deadline: ${deadlineText} (${deadline.label}).\n\n`
              : 'No submission deadline was found in the document.\n\n') +
            'Open BidLens to review the requirements, risks and fit.',
          deadline_text: deadlineText,
          days_remaining: deadline.days,
        })
      }

      // "The deadline is approaching."
      if (
        deadline.days !== null &&
        deadline.days >= 0 &&
        deadline.days <= withinDays
      ) {
        const threshold = thresholdFor(deadline.days)

        alerts.push({
          kind: 'deadline_approaching',
          rfp_id: row.rfp_id,
          owner_id: row.owner_id,
          title,
          threshold_days: threshold,
          subject: `BidLens: ${deadline.label} — ${title}`,
          text:
            `The submission deadline for "${title}" is approaching.\n\n` +
            `Deadline: ${deadlineText}\n` +
            `Time remaining: ${deadline.label}\n\n` +
            'Open BidLens to check outstanding requirements before submitting.',
          deadline_text: deadlineText,
          days_remaining: deadline.days,
        })
      }
    }

    const emails = await resolveEmails(alerts.map((alert) => alert.owner_id))

    for (const alert of alerts) {
      alert.email = emails.get(alert.owner_id) || null
    }

    // ── Delivery ─────────────────────────────────────────────────────────
    const configured = Boolean(
      process.env.ALERT_EMAIL_API_KEY && process.env.ALERT_EMAIL_FROM
    )

    let delivery = {
      attempted: false,
      configured,
      sent: 0,
      failed: 0,
      // Suppressed because they were sent on an earlier run. Reported
      // separately from `failed` — nothing went wrong, the work was simply
      // already done, and a scheduled run will report mostly these.
      skipped: 0,
      note: wantsSend
        ? configured
          ? null
          : 'send was requested but the provider is not configured — nothing was sent.'
        : 'Dry run. Pass {"send": true} to actually deliver these.',
    }

    // Marked on every alert, dry run included, so a dry run now answers "what
    // WOULD be sent" rather than "what matches the window" — the two stopped
    // being the same thing the moment sends became recorded.
    const { sent: alreadySent, error: logReadError } = await loadAlreadySent([
      ...new Set(alerts.map((alert) => alert.rfp_id)),
    ])

    for (const alert of alerts) {
      alert.already_notified = alreadySent.has(notificationKey(alert))
    }

    if (wantsSend && configured) {
      delivery.attempted = true

      for (const alert of alerts) {
        // A failed read of the log is NOT treated as "nothing was sent". That
        // assumption would turn one bad query into a duplicate of every alert
        // in the batch, which is the exact failure this table exists to stop.
        if (logReadError) {
          alert.delivery = {
            sent: false,
            error: `Could not read notification_log (${logReadError}); skipped rather than risk a duplicate.`,
          }
          delivery.skipped += 1

          continue
        }

        if (alert.already_notified) {
          alert.delivery = { sent: false, skipped: true, reason: 'already notified' }
          delivery.skipped += 1

          continue
        }

        if (!alert.email) {
          alert.delivery = { sent: false, error: 'No email address for this owner.' }
          delivery.failed += 1

          continue
        }

        const result = await sendEmail({
          to: alert.email,
          subject: alert.subject,
          text: alert.text,
        })

        alert.delivery = result

        if (result.sent) {
          delivery.sent += 1

          // Recorded only AFTER the provider accepted it. Logging before the
          // send would suppress a retry of something that never arrived.
          //
          // A failure here is logged and carried in the response, but does not
          // fail the request: the email is already gone, and reporting the
          // send as failed would be a lie that invites a manual re-send. The
          // cost of this branch is a possible duplicate on the next run, which
          // is strictly better than losing the confirmation.
          const { error: logWriteError } = await supabaseAdmin
            .from('notification_log')
            .insert({
              rfp_id: alert.rfp_id,
              owner_id: alert.owner_id,
              kind: alert.kind,
              threshold_days: normalizeThreshold(alert.threshold_days),
            })

          if (logWriteError) {
            console.error(
              '[alerts/check] SENT but could not record in notification_log —',
              `${alert.kind} for ${alert.rfp_id}:`,
              logWriteError.message,
              '— this alert may be re-sent on the next run.'
            )

            alert.delivery = { ...result, logged: false, log_error: logWriteError.message }
          } else {
            alert.delivery = { ...result, logged: true }
          }
        } else {
          delivery.failed += 1
        }
      }

      delivery.note = logReadError
        ? `notification_log could not be read (${logReadError}), so nothing was sent this run.`
        : delivery.sent === 0 && delivery.skipped > 0
          ? `Nothing new to send — all ${delivery.skipped} alert(s) were already notified on an earlier run.`
          : `${delivery.sent} sent, ${delivery.skipped} already notified.`
    }

    return res.status(200).json({
      checked_at: new Date().toISOString(),
      window: { within_days: withinDays, finished_within_hours: finishedWithinHours },
      rfps_considered: newestByRfp.size,
      alerts,
      counts: {
        total: alerts.length,
        analysis_complete: alerts.filter((a) => a.kind === 'analysis_complete').length,
        deadline_approaching: alerts.filter((a) => a.kind === 'deadline_approaching').length,
        without_email: alerts.filter((a) => !a.email).length,
        // How many of the matches above have already gone out. On a scheduled
        // run this is the number that matters — `total` stops meaning "will be
        // sent" once sends are recorded.
        already_notified: alerts.filter((a) => a.already_notified).length,
      },
      delivery,
    })
  } catch (err) {
    console.error('[alerts/check] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected error checking alerts',
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS STILL NEEDS (both are Zarman's manual steps, not applied here)
//
// 1. ENV VARS, for delivery:
//      ALERT_EMAIL_API_KEY   provider API key (this code targets Resend's
//                            REST API; any provider with a JSON POST would
//                            need the URL and body shape changed)
//      ALERT_EMAIL_FROM      verified sender, e.g. "BidLens <bids@yourdomain>"
//    Without both, the route stays permanently in dry run.
//
//    NOTE: onboarding@resend.dev is Resend's shared sandbox sender and will
//    only deliver to the Resend account owner's own address — every other
//    recipient comes back 403. Real delivery needs a verified domain.
//
// 2. SCHEDULING, once deployed. In vercel.json:
//
//      { "crons": [{ "path": "/api/alerts/check", "schedule": "0 13 * * *" }] }
//
//    Vercel Cron issues a GET, and a GET can never send (see wantsSend above),
//    so that guard has to be relaxed deliberately at the same time the
//    deduplication table lands — not before.
// ─────────────────────────────────────────────────────────────────────────
