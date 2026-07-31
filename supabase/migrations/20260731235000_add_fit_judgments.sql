-- ============================================================
-- fit_judgments — persisted §6.3 AI soft-fit verdicts
-- ============================================================
-- The other derived data in this app is deliberately NOT persisted:
-- scanContractRisk is pure regex over stored text, so re-deriving it on view
-- is cheaper than storing a copy that goes stale when the clause library
-- changes. That reasoning does not survive contact with §6.3.
--
-- A fit judgment costs real tokens, is non-deterministic, and is produced
-- against a 12,000 TPM rolling window that ~20,000 tokens of work cannot fit
-- inside. Without storage, a run that dies at batch 3 loses the two batches it
-- earned, and clicking again re-spends the window re-judging answers we
-- already had — so repeated clicks could make no forward progress at all.
-- Judgments are therefore stored for the same reason `requirements` is a table
-- rather than a re-derivation: the expensive part must survive.
--
-- STALENESS. A judgment is only meaningful against the company profile it was
-- made against — "can do" stops being true when the staff list shrinks.
-- judged_against_profile_updated_at records which profile produced it, and
-- readers compare it for EQUALITY against company_profile.updated_at. Any edit
-- through the settings form bumps that column via the existing
-- company_profile_set_updated_at trigger, so an edited profile invalidates
-- every judgment automatically and they get re-judged rather than silently
-- scoring today's RFP against last month's company.
--
-- No rfp_id column, matching requirement_links: judgments carry no rfp of
-- their own, so an RFP's requirement ids ARE the filter, and the cascade
-- through requirements -> rfps already cleans up deletions.
--
-- No needs_review column either, unlike requirements. There it had to be
-- stored because confidence = 0 could mean "never classified" OR "classified
-- with no certainty", and a query-time threshold would conflate the two. A row
-- here exists only when the model actually returned a usable verdict, so
-- "needs review" is unambiguously derivable from confidence at read time —
-- which also means the threshold can be retuned without a backfill.

create table public.fit_judgments (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirements(id) on delete cascade,
  verdict text not null check (verdict in ('can_do', 'partial', 'gap')),
  evidence_rfp text,
  evidence_profile text,
  note text,
  confidence numeric(3,2),
  judged_against_profile_updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One live judgment per requirement. Re-judging a stale one overwrites it
  -- rather than accumulating history: every reader wants "the current verdict",
  -- and a history table nobody queries is just a way to get the current
  -- verdict wrong.
  unique (requirement_id)
);

alter table public.fit_judgments enable row level security;

create policy "fit_judgments_select_own"
  on public.fit_judgments for select
  using (exists (
    select 1 from public.requirements r
    join public.rfps on rfps.id = r.rfp_id
    where r.id = fit_judgments.requirement_id
      and rfps.owner_id = auth.uid()
  ));

create policy "fit_judgments_insert_own"
  on public.fit_judgments for insert
  with check (exists (
    select 1 from public.requirements r
    join public.rfps on rfps.id = r.rfp_id
    where r.id = fit_judgments.requirement_id
      and rfps.owner_id = auth.uid()
  ));

create policy "fit_judgments_update_own"
  on public.fit_judgments for update
  using (exists (
    select 1 from public.requirements r
    join public.rfps on rfps.id = r.rfp_id
    where r.id = fit_judgments.requirement_id
      and rfps.owner_id = auth.uid()
  ));

create policy "fit_judgments_delete_own"
  on public.fit_judgments for delete
  using (exists (
    select 1 from public.requirements r
    join public.rfps on rfps.id = r.rfp_id
    where r.id = fit_judgments.requirement_id
      and rfps.owner_id = auth.uid()
  ));

create trigger fit_judgments_set_updated_at
  before update on public.fit_judgments
  for each row execute procedure public.set_updated_at();

comment on column public.fit_judgments.judged_against_profile_updated_at is
  'company_profile.updated_at at the moment this verdict was produced. Readers require an exact match; anything else is stale and must be re-judged.';
