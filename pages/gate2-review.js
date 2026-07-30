import { useMemo, useState } from 'react'

// TEMPORARY — Gate 2 manual accuracy check for the shredder.
//
// Pulls a random sample of classified requirements for one RFP and lets a
// human mark each label Correct or Wrong. Nothing is written back; the tally
// lives in component state and disappears on refresh. Delete this file once
// Gate 2 passes.
//
// Usage: /gate2-review?rfp_id=<uuid>

const SAMPLE_SIZE = 25

export async function getServerSideProps({ query }) {
  const rfpId = typeof query.rfp_id === 'string' ? query.rfp_id.trim() : ''

  if (!rfpId) {
    return { props: { rfpId: '', rows: [], totalAvailable: 0, error: null } }
  }

  // Required lazily so a missing service-role key surfaces as a page message
  // rather than a build-time crash.
  const { supabaseAdmin } = require('../lib/supabase/admin')

  const { data, error } = await supabaseAdmin
    .from('requirements')
    .select(
      'req_number, requirement_text, page, section, role, department, confidence, needs_review'
    )
    .eq('rfp_id', rfpId)
    // Rows with a classification_error never reached the model (quota
    // failures, unparseable batches). There is no AI judgement to grade, so
    // they are excluded. Low-confidence rows DO stay in — those are real
    // classifications and exactly what Gate 2 needs to measure.
    .is('classification_error', null)
    .not('role', 'is', null)

  if (error) {
    return {
      props: { rfpId, rows: [], totalAvailable: 0, error: error.message },
    }
  }

  const all = data || []

  // Shuffle server-side so every load grades a fresh sample.
  const shuffled = [...all]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  return {
    props: {
      rfpId,
      rows: shuffled.slice(0, SAMPLE_SIZE),
      totalAvailable: all.length,
      error: null,
    },
  }
}

const ROLE_LABELS = {
  work_requirement: 'Work requirement',
  submission_instruction: 'Submission instruction',
  evaluation_factor: 'Evaluation factor',
  // Deliberately kept in the review sample: "the model declined to assign a
  // role" is a judgement worth grading, not an absence of one.
  not_applicable: 'Not a contractor requirement',
}

export default function Gate2Review({ rfpId, rows, totalAvailable, error }) {
  const [verdicts, setVerdicts] = useState({})

  const stats = useMemo(() => {
    const values = Object.values(verdicts)
    const correct = values.filter((v) => v === 'correct').length
    const wrong = rows
      .filter((row) => verdicts[row.req_number] === 'wrong')
      .map((row) => row.req_number)
      .sort()

    return {
      reviewed: values.length,
      correct,
      wrong,
      accuracy: values.length > 0 ? (correct / values.length) * 100 : 0,
    }
  }, [verdicts, rows])

  function mark(reqNumber, verdict) {
    setVerdicts((prev) => ({
      ...prev,
      // Clicking the same button again clears the verdict, so a misclick is
      // recoverable without reloading and losing the whole sample.
      [reqNumber]: prev[reqNumber] === verdict ? undefined : verdict,
    }))
  }

  if (!rfpId) {
    return (
      <div className="container py-5">
        <h1 className="h4">Gate 2 review</h1>
        <div className="alert alert-info mt-3">
          Add an <code>rfp_id</code> to the URL, e.g.
          <br />
          <code>/gate2-review?rfp_id=00000000-0000-0000-0000-000000000000</code>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="container py-5">
        <h1 className="h4">Gate 2 review</h1>
        <div className="alert alert-danger mt-3">
          Could not load requirements: {error}
        </div>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="container py-5">
        <h1 className="h4">Gate 2 review</h1>
        <div className="alert alert-warning mt-3">
          <strong>No classified requirements found for this RFP.</strong>
          <div className="mt-2">
            Run the shredder pipeline first:
            <br />
            <code>
              POST /api/shredder/run &nbsp;&#123;&quot;rfp_id&quot;:&quot;
              {rfpId}&quot;&#125;
            </code>
          </div>
          <hr />
          <small className="text-muted">
            Rows that failed classification (quota errors, unparseable
            batches) are excluded on purpose — there is no AI judgement to
            grade on those.
          </small>
        </div>
      </div>
    )
  }

  return (
    <div className="container py-4" style={{ maxWidth: 1100 }}>
      <h1 className="h4">Gate 2 review</h1>
      <p className="text-muted small mb-3">
        RFP <code>{rfpId}</code> — random sample of {rows.length} from{' '}
        {totalAvailable} classified requirements. Nothing is saved; refresh
        for a new sample.
      </p>

      {/* Running tally */}
      <div
        className="card mb-4 shadow-sm"
        style={{ position: 'sticky', top: 0, zIndex: 10 }}
      >
        <div className="card-body py-3">
          <div className="d-flex flex-wrap gap-4 align-items-center">
            <div>
              <div className="fs-5 fw-semibold">
                {stats.reviewed} / {rows.length} reviewed
              </div>
              <div className="text-muted small">
                {stats.correct} correct so far
              </div>
            </div>

            <div>
              <div className="fs-5 fw-semibold">
                {stats.reviewed > 0 ? stats.accuracy.toFixed(1) + '%' : '—'}
              </div>
              <div className="text-muted small">accuracy</div>
            </div>

            <div className="flex-grow-1" style={{ minWidth: 180 }}>
              <div className="progress" style={{ height: 8 }}>
                <div
                  className="progress-bar bg-success"
                  style={{
                    width: `${(stats.reviewed / rows.length) * 100}%`,
                  }}
                />
              </div>
            </div>

            {stats.reviewed > 0 && (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setVerdicts({})}
              >
                Reset
              </button>
            )}
          </div>

          {stats.wrong.length > 0 && (
            <div className="mt-3 pt-2 border-top">
              <span className="text-muted small">Marked wrong: </span>
              <code className="small">{stats.wrong.join(', ')}</code>
            </div>
          )}
        </div>
      </div>

      {/* Items */}
      {rows.map((row, index) => {
        const verdict = verdicts[row.req_number]

        return (
          <div
            key={row.req_number}
            className={
              'card mb-3 ' +
              (verdict === 'correct'
                ? 'border-success'
                : verdict === 'wrong'
                  ? 'border-danger'
                  : '')
            }
          >
            <div className="card-body">
              <div className="row g-3">
                {/* Left: the source text */}
                <div className="col-md-7">
                  <div className="d-flex gap-2 align-items-center mb-2">
                    <span className="badge bg-secondary">
                      {row.req_number}
                    </span>
                    <span className="text-muted small">
                      #{index + 1} · page {row.page ?? '—'}
                    </span>
                  </div>

                  <p className="mb-2">{row.requirement_text}</p>

                  {row.section && (
                    <div className="text-muted small">
                      <strong>Section:</strong> {row.section}
                    </div>
                  )}
                </div>

                {/* Right: what the AI said */}
                <div className="col-md-5">
                  <div className="bg-light rounded p-3 h-100">
                    <div className="mb-2">
                      <div className="text-muted small">Role</div>
                      <div className="fw-semibold">
                        {ROLE_LABELS[row.role] || row.role}
                      </div>
                    </div>

                    <div className="mb-2">
                      <div className="text-muted small">Department</div>
                      <div className="fw-semibold">
                        {row.department || <em className="text-muted">none</em>}
                      </div>
                    </div>

                    <div className="mb-3">
                      <div className="text-muted small">Confidence</div>
                      <div className="fw-semibold">
                        {row.confidence ?? '—'}
                        {row.needs_review && (
                          <span className="badge bg-warning text-dark ms-2">
                            low
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="d-flex gap-2">
                      <button
                        type="button"
                        className={
                          'btn btn-sm flex-fill ' +
                          (verdict === 'correct'
                            ? 'btn-success'
                            : 'btn-outline-success')
                        }
                        onClick={() => mark(row.req_number, 'correct')}
                      >
                        Correct
                      </button>

                      <button
                        type="button"
                        className={
                          'btn btn-sm flex-fill ' +
                          (verdict === 'wrong'
                            ? 'btn-danger'
                            : 'btn-outline-danger')
                        }
                        onClick={() => mark(row.req_number, 'wrong')}
                      >
                        Wrong
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      })}

      {/* Summary */}
      <div className="card mb-5">
        <div className="card-body">
          <h2 className="h6">Summary</h2>

          {stats.reviewed < rows.length && (
            <p className="text-muted small mb-2">
              {rows.length - stats.reviewed} still to review.
            </p>
          )}

          <table className="table table-sm mb-3">
            <tbody>
              <tr>
                <td>Reviewed</td>
                <td className="fw-semibold">
                  {stats.reviewed} / {rows.length}
                </td>
              </tr>
              <tr>
                <td>Correct</td>
                <td className="fw-semibold">{stats.correct}</td>
              </tr>
              <tr>
                <td>Wrong</td>
                <td className="fw-semibold">{stats.wrong.length}</td>
              </tr>
              <tr>
                <td>Accuracy</td>
                <td className="fw-semibold">
                  {stats.reviewed > 0
                    ? stats.accuracy.toFixed(1) + '%'
                    : 'not started'}
                </td>
              </tr>
            </tbody>
          </table>

          <div className="text-muted small">
            <strong>Wrong req_numbers:</strong>{' '}
            {stats.wrong.length > 0 ? (
              <code>{stats.wrong.join(', ')}</code>
            ) : (
              'none'
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
