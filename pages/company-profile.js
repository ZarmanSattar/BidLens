import Link from 'next/link'
import { useState } from 'react'
import CompanyProfileForm from '../components/CompanyProfileForm'

// §6.1 — the company profile settings page.
//
// One page, one row. company_profile is a singleton by design (one company,
// one profile), and its RLS is company-wide rather than owner-scoped, so there
// is no per-user variant of this screen to build.
//
// Server-rendered through supabaseAdmin, the same way traceability.js and
// gate2-review.js read their data: the profile's RLS would reject the
// browser's anon client, and rendering the saved values into the form on the
// first paint avoids a load-then-populate flash on a form the user is about
// to type into.

export async function getServerSideProps() {
  // Required lazily so a missing service-role key surfaces as a page message
  // rather than a build-time crash.
  const { supabaseAdmin } = require('../lib/supabase/admin')

  const { data, error } = await supabaseAdmin
    .from('company_profile')
    .select(
      'id, certificates, insurance_limit, bonding_capacity, registrations, ' +
        'staff, geography, past_projects, updated_at'
    )
    .order('updated_at', { ascending: false })
    .limit(1)

  if (error) {
    return { props: { profile: null, error: error.message } }
  }

  return {
    props: {
      profile: (data && data[0]) || null,
      error: null,
    },
  }
}

export default function CompanyProfilePage({ profile, error }) {
  const [saved, setSaved] = useState(profile)

  const isEmpty =
    !saved ||
    (saved.insurance_limit === null &&
      saved.bonding_capacity === null &&
      (saved.certificates || []).length === 0)

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

      <div className="container py-4" style={{ maxWidth: 960 }}>
        <div className="mb-4">
          <h1 className="fw-bold h3 mb-1">🏢 Company Profile</h1>
          <p className="text-muted mb-0">
            What this company holds, carries, and has done. Every fit check
            reads from here — the hard blocker rules compare against it exactly,
            and the AI fit judgment uses it as its only evidence about you.
          </p>
        </div>

        {error && (
          <div className="alert alert-danger">
            Could not load the company profile: {error}
          </div>
        )}

        {isEmpty && !error && (
          <div className="alert alert-info">
            <strong>Nothing on file yet.</strong>
            <div className="mt-2 small">
              Until this is filled in, the blocker checks report{' '}
              <em>&ldquo;nothing could be checked&rdquo;</em> rather than
              &ldquo;no problems found&rdquo;, and the AI fit judgment refuses
              to run rather than spending tokens to tell you the profile is
              empty.
            </div>
          </div>
        )}

        {saved?.updated_at && (
          <p className="text-muted small">
            Last saved {new Date(saved.updated_at).toLocaleString()}
          </p>
        )}

        <CompanyProfileForm profile={saved} onSaved={setSaved} />
      </div>
    </>
  )
}
