-- ============================================================
-- Module 3 (§8.1-§8.4) — content library and response skeletons
-- ============================================================
-- Part 1 of 2. This migration creates the SCHEMA only. Nothing populates
-- response_skeletons yet: the generation pass (§8.3) lands in Part 2, and no
-- AI call exists anywhere in this change.

-- ------------------------------------------------------------
-- content_library (§8.1) — completing a table that already existed
-- ------------------------------------------------------------
-- The table shipped in the initial schema with category/title/content/tags,
-- but two things it needs are missing.
--
-- updated_at is the important one. §8.2's staleness rule compares a skeleton
-- against the library it was written from, and without a per-entry timestamp
-- there is nothing to compare — a library edit would silently leave every
-- skeleton looking current. This is the same mechanism company_profile.
-- updated_at provides for fit_judgments.
--
-- The category CHECK pins the taxonomy the settings UI offers. A free-text
-- category would drift ("past_project", "Past Project", "project") and §8.3
-- selects content BY category, so drift there means silently missing content.

alter table public.content_library
  add column updated_at timestamptz not null default now();

create trigger content_library_set_updated_at
  before update on public.content_library
  for each row execute procedure public.set_updated_at();

alter table public.content_library
  add constraint content_library_category_check
  check (category in (
    'company_description',
    'past_project',
    'certificate',
    'staff_bio',
    'standard_approach'
  ));

create index content_library_category_idx on public.content_library(category);

comment on column public.content_library.updated_at is
  'Bumped on every edit. A response skeleton generated before this timestamp was written from older content and is stale.';

-- ------------------------------------------------------------
-- response_skeletons (§8.3 schema, populated in Part 2)
-- ------------------------------------------------------------
-- One draft response per requirement. Created empty on purpose: §8.4's
-- coverage counter is meant to read this table today and honestly report
-- 0 of N covered, rather than being wired up to a table that does not exist.
--
-- WHICH REQUIREMENTS GET A SKELETON
--
-- work_requirement and evaluation_factor, and only those two.
--   - work_requirement needs "here is how we will do this".
--   - evaluation_factor needs "here is why we score well on this" — these are
--     literally what the proposal is graded on, so drafting everything except
--     them would miss the scored content.
--   - submission_instruction is a packaging checklist (page limits, forms,
--     copies). Those are actions to complete, not prose to draft; a generated
--     paragraph would be noise.
--   - not_applicable obligates nobody.
-- On the reference dataset that is 84 + 25 = 109 of 222 requirements.
--
-- STALENESS IS DERIVED, NEVER STORED
--
-- Same rule as fit_judgments: no boolean on this table can be trusted, because
-- it goes out of date the moment something it describes changes. A skeleton is
-- stale when ANY of these hold, all computed at read time:
--
--   1. LIBRARY EDITED — any entry in library_entry_ids has
--      content_library.updated_at > generated_against_library_updated_at.
--      The text it was built from has changed underneath it.
--   2. LIBRARY ENTRY DELETED — an id in library_entry_ids no longer exists in
--      content_library. The skeleton cites something that is gone.
--   3. REQUIREMENT CHANGED OR REMOVED — the requirement_id appears in
--      Module 5's requirement_changes with change_type in
--      ('changed','removed'). The skeleton answers wording that no longer
--      applies. This is the identical join §7.4 uses for fit judgments.
--
-- A fourth, SOFTER signal is deliberately NOT treated as staleness: new
-- library entries added since generation might improve a skeleton, but they do
-- not make it wrong. Reporting that as "stale" would mark every skeleton stale
-- every time anyone adds a paragraph.

create table public.response_skeletons (
  id uuid primary key default gen_random_uuid(),
  -- One live skeleton per requirement; regenerating replaces it.
  requirement_id uuid not null unique
    references public.requirements(id) on delete cascade,
  -- Denormalized so a skeleton can be listed or exported without joining back
  -- to requirements. requirements.req_number is immutable once assigned, so
  -- this cannot drift.
  req_number text not null,
  content text not null,
  -- Which library entries the generator actually drew on. No foreign key is
  -- possible on array elements, which is why rule 2 above checks for missing
  -- ids explicitly rather than relying on a cascade.
  library_entry_ids uuid[] not null default '{}',
  -- The library state this was written from. Compared against the referenced
  -- entries' updated_at to detect rule 1.
  generated_against_library_updated_at timestamptz not null,
  -- Provenance, so a model change is visible when output quality shifts.
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index response_skeletons_requirement_id_idx
  on public.response_skeletons(requirement_id);

alter table public.response_skeletons enable row level security;

create policy "response_skeletons_select_own"
  on public.response_skeletons for select
  using (exists (
    select 1 from public.requirements r
    join public.rfps on rfps.id = r.rfp_id
    where r.id = response_skeletons.requirement_id
      and rfps.owner_id = auth.uid()
  ));

create policy "response_skeletons_write_own"
  on public.response_skeletons for all
  using (exists (
    select 1 from public.requirements r
    join public.rfps on rfps.id = r.rfp_id
    where r.id = response_skeletons.requirement_id
      and rfps.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.requirements r
    join public.rfps on rfps.id = r.rfp_id
    where r.id = response_skeletons.requirement_id
      and rfps.owner_id = auth.uid()
  ));

create trigger response_skeletons_set_updated_at
  before update on public.response_skeletons
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- §8.2 — RETRIEVAL APPROACH (design note; implemented in Part 2)
-- ============================================================
-- DECISION: send the WHOLE content library in the generation prompt. No
-- embedding index, no vector store, no separate retrieval step.
--
-- WHY NOT RETRIEVAL
--
-- The corpus is a few dozen hand-written paragraphs authored by one team, not
-- a document store. Semantic search earns its complexity when the corpus
-- cannot fit in context; here it would add a dependency, an index to keep in
-- sync with every library edit, and a silent failure mode (the retriever
-- fetches the wrong three entries and the model never sees the right one)
-- in exchange for solving a problem the library does not have.
--
-- THE REAL CONSTRAINT IS TPM, NOT CONTEXT
--
-- Measured from Module 2's batching work: llama-3.3-70b on this tier has a
-- 12,000 token-per-minute cap, and Groq counts the max_tokens reservation as
-- part of the request. §6.3 lands at ~5,200 tokens per 20-requirement call
-- with a ~300-token company profile resent each time.
--
-- A content library is far larger than a company profile. At ~150 tokens per
-- entry, 30 entries is ~4,500 tokens — resent with EVERY batch, exactly like
-- the profile block. Adding that to the §6.3 shape gives roughly:
--
--     700 system + 4,500 library + 2,000 requirement text
--       + 2,200 completion reservation  =  ~9,400 per call
--
-- which is uncomfortably close to the 12,000 cap before the library grows at
-- all. So Part 2 must do ONE of these, and should measure before choosing:
--
--   (a) smaller batches (8-10 requirements) to make room for the library,
--   (b) send only the categories a requirement plausibly needs — its
--       department maps well to category (Technical -> standard_approach,
--       past_project; Legal -> certificate), which is filtering, not
--       retrieval, and stays deterministic and debuggable,
--   (c) cap library entries per call by recency or an explicit "always
--       include" flag.
--
-- (b) is the recommended starting point: it keeps the "no retrieval" property
-- (no index, no embeddings, no relevance model) while bounding the prompt.

comment on table public.response_skeletons is
  'Draft responses, one per work_requirement/evaluation_factor. Populated by §8.3 in Part 2. Staleness is derived at read time, never stored — see the migration for the three rules.';
