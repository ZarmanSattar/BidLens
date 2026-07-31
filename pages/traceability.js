import Link from 'next/link'
import { useRouter } from 'next/router'
import TraceabilityMatrix, {
  joinRequirementLinks,
} from '../components/TraceabilityMatrix'
import CompanyFitCard from '../components/CompanyFitCard'
import ResponseCoverageCard from '../components/ResponseCoverageCard'

// §4.5 — standalone Traceability Matrix, addressable by rfp_id.
//
// The matrix also lives as a card inside ResultsPanel, but that card can only
// ever show the RFP the current session just analyzed. This page exists so any
// shredded RFP can be opened directly — including datasets produced by running
// the shredder over the API with no browser involved.
//
// Usage: /traceability?rfp_id=<uuid>

export async function getServerSideProps({ query }) {
  const rfpId = typeof query.rfp_id === 'string' ? query.rfp_id.trim() : ''

  if (!rfpId) {
    return { props: { rfpId: '', title: '', rows: [], error: null } }
  }

  // Required lazily so a missing service-role key surfaces as a page message
  // rather than a build-time crash — the same reason gate2-review does it.
  const { supabaseAdmin } = require('../lib/supabase/admin')

  const { data: rfp } = await supabaseAdmin
    .from('rfps')
    .select('title')
    .eq('id', rfpId)
    .maybeSingle()

  const { data: requirements, error: requirementsError } = await supabaseAdmin
    .from('requirements')
    .select(
      'id, req_number, requirement_text, page, section, role, department, ' +
        'confidence, needs_review, classification_error'
    )
    .eq('rfp_id', rfpId)

  if (requirementsError) {
    return {
      props: { rfpId, title: '', rows: [], error: requirementsError.message },
    }
  }

  const rows = requirements || []

  // Scoped by requirement_id rather than fetching the whole table: the link
  // rows carry no rfp_id of their own, so this RFP's requirement ids ARE the
  // filter.
  const { data: links, error: linksError } = rows.length
    ? await supabaseAdmin
        .from('requirement_links')
        .select('id, requirement_id, linked_requirement_id, relationship_note')
        .in(
          'requirement_id',
          rows.map((row) => row.id)
        )
    : { data: [], error: null }

  if (linksError) {
    return { props: { rfpId, title: '', rows: [], error: linksError.message } }
  }

  // Sorted by the numeric tail of the REQ number so REQ-2 does not sort
  // between REQ-19 and REQ-20 the way a plain string sort would put it.
  const joined = joinRequirementLinks(rows, links || []).sort((a, b) => {
    const sequence = (value) => Number(/(\d+)\s*$/.exec(value || '')?.[1] || 0)

    return sequence(a.req_number) - sequence(b.req_number)
  })

  return {
    props: {
      rfpId,
      title: rfp?.title || '',
      rows: joined,
      error: null,
    },
  }
}

export default function TraceabilityPage({ rfpId, title, rows, error }) {
  const router = useRouter()

  return (
    <>
      <nav className="navbar navbar-dark bg-dark px-4">
        <span className="navbar-brand fw-bold fs-4">
          Bid<span>Lens</span>
        </span>
        <div className="d-flex align-items-center gap-3">
          <Link href="/dashboard" className="btn btn-outline-light btn-sm">
            📊 Dashboard
          </Link>
        </div>
      </nav>

      <div className="container-fluid py-4 px-4">
        <div className="mb-4">
          <h1 className="fw-bold h3 mb-1">🔗 Traceability Matrix</h1>
          <p className="text-muted mb-0">
            Every shredded requirement for this RFP, with the requirements it is
            submitted under or scored by.
          </p>
        </div>

        {!rfpId ? (
          <div className="alert alert-info">
            <strong>No RFP selected.</strong>
            <div className="mt-2 small">
              Open this page with an RFP id:{' '}
              <code>/traceability?rfp_id=&lt;uuid&gt;</code>
            </div>
          </div>
        ) : (
          <>
            <div className="card shadow-sm border-0 mb-4">
              <div className="card-body py-3 bg-light d-flex flex-wrap gap-4">
                <div>
                  <div className="text-muted small text-uppercase fw-bold">
                    RFP
                  </div>
                  <div className="fw-semibold text-dark">
                    {title || 'Untitled'}
                  </div>
                </div>
                <div>
                  <div className="text-muted small text-uppercase fw-bold">
                    rfp_id
                  </div>
                  <code className="text-dark">{rfpId}</code>
                </div>
              </div>
            </div>

            {/* Company Fit (§6.4). Mounted here as well as in ResultsPanel
                because this page is the only route that can open an already
                shredded RFP by id — including datasets produced over the API
                with no browser session behind them, which is exactly the state
                a fit check is useful in. */}
            <CompanyFitCard rfpId={rfpId} />

            {/* Response coverage (§8.4). Follows Company Fit because it asks
                the next question: fit is whether we CAN do the work, this is
                how much of the answer has actually been written. */}
            <ResponseCoverageCard rfpId={rfpId} />

            <div className="card shadow-sm border-0">
              <div className="card-body p-0 bg-white rounded">
                <TraceabilityMatrix
                  rows={rows}
                  error={error}
                  rfpId={rfpId}
                  // This page builds its rows in getServerSideProps, so the
                  // refresh has to go back through the server rather than
                  // re-running a client fetch.
                  onShredded={() =>
                    router.replace(router.asPath, undefined, { scroll: false })
                  }
                />
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}
