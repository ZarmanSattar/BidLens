-- ============================================================
-- Module 5 (§7.1-§7.4) — multi-file packages and amendment tracking
-- ============================================================
-- Strictly additive. Nothing an existing single-file RFP depends on changes:
-- rfps.raw_text and rfps.pages keep their exact meaning, and every route that
-- reads them (shredder/run, risk/scan, risk/explain) is untouched.

-- ------------------------------------------------------------
-- rfp_files (§7.1) — the files that make up one RFP package
-- ------------------------------------------------------------
-- The package's combined text still lives on rfps.raw_text / rfps.pages, and
-- that stays authoritative. This table records what the combination was MADE
-- OF, which is the part the concatenation destroys:
--
--   - which file a given package page came from (page_offset), so a finding on
--     package page 47 can be reported as "Attachment B, page 3",
--   - per-file text, so §7.2 can compare files AGAINST EACH OTHER.
--
-- Keeping rfps.pages as the source of truth for the pipelines is deliberate:
-- it is what lets multi-file packages work without editing a single line of
-- the shredder or risk routes, and what keeps every RFP uploaded before this
-- migration behaving exactly as it did.
--
-- READER RULE: no rfp_files rows for an rfp_id means "single file" — fall back
-- to rfps.raw_text / rfps.pages. Every RFP that exists today is in that state
-- and must stay working.
--
-- No file bytes. storage_path has always been null in practice; only extracted
-- text is kept, so a re-shred never needs the original upload.

create table public.rfp_files (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid not null references public.rfps(id) on delete cascade,
  filename text not null,
  -- 'base' is the solicitation itself; 'attachment' is everything bundled with
  -- it (exhibits, wage determinations, pricing sheets, Q&A).
  role text not null default 'attachment' check (role in ('base', 'attachment')),
  sort_order integer not null default 0,
  raw_text text,
  pages text[],
  -- 0-based index into rfps.pages where this file's first page sits.
  -- package_page = page_offset + file_page.
  page_offset integer not null default 0,
  page_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (rfp_id, sort_order)
);

create index rfp_files_rfp_id_idx on public.rfp_files(rfp_id);

alter table public.rfp_files enable row level security;

create policy "rfp_files_select_own"
  on public.rfp_files for select
  using (exists (
    select 1 from public.rfps
    where rfps.id = rfp_files.rfp_id and rfps.owner_id = auth.uid()
  ));

create policy "rfp_files_insert_own"
  on public.rfp_files for insert
  with check (exists (
    select 1 from public.rfps
    where rfps.id = rfp_files.rfp_id and rfps.owner_id = auth.uid()
  ));

create policy "rfp_files_update_own"
  on public.rfp_files for update
  using (exists (
    select 1 from public.rfps
    where rfps.id = rfp_files.rfp_id and rfps.owner_id = auth.uid()
  ));

create policy "rfp_files_delete_own"
  on public.rfp_files for delete
  using (exists (
    select 1 from public.rfps
    where rfps.id = rfp_files.rfp_id and rfps.owner_id = auth.uid()
  ));

comment on column public.rfp_files.page_offset is
  '0-based index into rfps.pages where this file begins. package page = page_offset + file page.';

-- ------------------------------------------------------------
-- amendments (§7.3) — one original per amendment
-- ------------------------------------------------------------
-- The table already existed from the initial schema with the right columns and
-- RLS; what it lacked was any guarantee that an amended RFP has exactly ONE
-- original. Without this, two rows could claim different originals for the
-- same amendment and every reader would be picking one arbitrarily.

create unique index amendments_amended_rfp_id_key
  on public.amendments(amended_rfp_id);

comment on index public.amendments_amended_rfp_id_key is
  'An amended RFP amends exactly one original.';

-- ------------------------------------------------------------
-- requirement_changes (§7.3) — the diff, one row per matched pair
-- ------------------------------------------------------------
-- 'unchanged' rows ARE stored, which is the difference between an amendment
-- costing tokens proportional to the diff and costing a full re-judge. The
-- mapping they carry is what lets a fit judgment on the original requirement
-- be carried forward to its amended twin; without it, nothing knows which
-- amended requirement corresponds to which original and every amendment pays
-- ~20,000 tokens to re-derive answers that did not change.
--
-- Staleness is NOT stored anywhere. A fit judgment is stale when its
-- requirement appears here as 'changed' or 'removed', which is a read-time
-- join — no second copy of the truth to drift, and re-running a diff corrects
-- it automatically.

create table public.requirement_changes (
  id uuid primary key default gen_random_uuid(),
  amendment_id uuid not null references public.amendments(id) on delete cascade,
  original_requirement_id uuid references public.requirements(id) on delete cascade,
  amended_requirement_id uuid references public.requirements(id) on delete cascade,
  change_type text not null
    check (change_type in ('added', 'removed', 'changed', 'unchanged')),
  -- 0..1 text similarity for matched pairs, null for added/removed.
  similarity numeric(4,3),
  -- How the pair was matched: exact | normalized | similarity | ai
  match_method text,
  note text,
  created_at timestamptz not null default now(),
  -- Each change_type implies exactly which side must be present. Enforced here
  -- rather than in application code because a malformed row would silently
  -- corrupt the counts every §7.4 view is built on.
  check (
    (change_type = 'added'
      and original_requirement_id is null
      and amended_requirement_id is not null)
    or (change_type = 'removed'
      and original_requirement_id is not null
      and amended_requirement_id is null)
    or (change_type in ('changed', 'unchanged')
      and original_requirement_id is not null
      and amended_requirement_id is not null)
  )
);

create index requirement_changes_amendment_id_idx
  on public.requirement_changes(amendment_id);

create index requirement_changes_original_idx
  on public.requirement_changes(original_requirement_id);

-- Partial, because added/removed rows legitimately carry a null on one side
-- and null is not equal to null for uniqueness purposes.
create unique index requirement_changes_original_unique
  on public.requirement_changes(amendment_id, original_requirement_id)
  where original_requirement_id is not null;

create unique index requirement_changes_amended_unique
  on public.requirement_changes(amendment_id, amended_requirement_id)
  where amended_requirement_id is not null;

alter table public.requirement_changes enable row level security;

create policy "requirement_changes_select_own"
  on public.requirement_changes for select
  using (exists (
    select 1 from public.amendments a
    join public.rfps on rfps.id = a.original_rfp_id
    where a.id = requirement_changes.amendment_id
      and rfps.owner_id = auth.uid()
  ));

create policy "requirement_changes_write_own"
  on public.requirement_changes for all
  using (exists (
    select 1 from public.amendments a
    join public.rfps on rfps.id = a.original_rfp_id
    where a.id = requirement_changes.amendment_id
      and rfps.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.amendments a
    join public.rfps on rfps.id = a.original_rfp_id
    where a.id = requirement_changes.amendment_id
      and rfps.owner_id = auth.uid()
  ));
