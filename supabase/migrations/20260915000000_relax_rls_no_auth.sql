-- ============================================================
-- Relax RLS so the app works with no logged-in user
-- ============================================================
-- Login and signup were removed from BidLens. Every table below was gated on
-- the signed-in user — either auth.uid() = owner_id directly, an EXISTS
-- subquery reaching rfps.owner_id, or auth.role() = 'authenticated'. With no
-- session auth.uid() is null and auth.role() is 'anon', so every one of those
-- predicates is false: selects return nothing and writes are rejected. The
-- pages render but the app cannot read or write its own data.
--
-- This migration drops those 33 policies and replaces them with permissive
-- ones, four per table, one for each command.
--
-- WHAT THIS GIVES UP. The anon key ships in the client bundle, so after this
-- migration anyone who loads the site can read, modify and delete every row in
-- these tables. RLS is no longer providing access control of any kind — it
-- stays enabled, with policies that always pass. That is the unavoidable cost
-- of an auth-less app talking straight to PostgREST, and it is fine for local
-- and internal use. Do not put this on a public URL without reintroducing
-- access control somewhere else: an API route holding the service-role key, a
-- network boundary, or auth again.
--
-- public.profiles is deliberately left alone. No application code queries it,
-- and its rows are keyed to auth.users entries that are no longer created.
--
-- Two tables the app queries have no policies to relax because they were never
-- created in any migration: public.item_notes (TeamNotes) and
-- public.notification_log (pages/api/alerts/check.js). Both are pre-existing
-- gaps unrelated to auth, and out of scope here.
--
-- "drop policy if exists" rather than a bare drop, so this migration is
-- re-runnable and does not fail against a database where a policy was already
-- removed by hand.
--
-- On the four-policies-per-table shape: Postgres rejects WITH CHECK on a SELECT
-- or DELETE policy, and rejects USING on an INSERT policy. So the permissive
-- set below is "using (true)" for select and delete, "with check (true)" for
-- insert, and both for update. The effect is what was asked for — every command
-- unconditionally allowed — written the way Postgres accepts it.


-- ── rfps ────────────────────────────────────────────────────
drop policy if exists "rfps_select_own" on public.rfps;
drop policy if exists "rfps_insert_own" on public.rfps;
drop policy if exists "rfps_update_own" on public.rfps;
drop policy if exists "rfps_delete_own" on public.rfps;

create policy "rfps_select_public" on public.rfps for select using (true);
create policy "rfps_insert_public" on public.rfps for insert with check (true);
create policy "rfps_update_public" on public.rfps for update using (true) with check (true);
create policy "rfps_delete_public" on public.rfps for delete using (true);


-- ── analyses ────────────────────────────────────────────────
drop policy if exists "analyses_select_own" on public.analyses;
drop policy if exists "analyses_insert_own" on public.analyses;
drop policy if exists "analyses_update_own" on public.analyses;
drop policy if exists "analyses_delete_own" on public.analyses;

create policy "analyses_select_public" on public.analyses for select using (true);
create policy "analyses_insert_public" on public.analyses for insert with check (true);
create policy "analyses_update_public" on public.analyses for update using (true) with check (true);
create policy "analyses_delete_public" on public.analyses for delete using (true);


-- ── requirements ────────────────────────────────────────────
drop policy if exists "requirements_select_own" on public.requirements;
drop policy if exists "requirements_insert_own" on public.requirements;
drop policy if exists "requirements_update_own" on public.requirements;
drop policy if exists "requirements_delete_own" on public.requirements;

create policy "requirements_select_public" on public.requirements for select using (true);
create policy "requirements_insert_public" on public.requirements for insert with check (true);
create policy "requirements_update_public" on public.requirements for update using (true) with check (true);
create policy "requirements_delete_public" on public.requirements for delete using (true);


-- ── requirement_links ───────────────────────────────────────
-- Had no UPDATE policy before this migration, so the update below is new
-- capability rather than a relaxed version of something that already existed.
drop policy if exists "requirement_links_select_own" on public.requirement_links;
drop policy if exists "requirement_links_insert_own" on public.requirement_links;
drop policy if exists "requirement_links_delete_own" on public.requirement_links;

create policy "requirement_links_select_public" on public.requirement_links for select using (true);
create policy "requirement_links_insert_public" on public.requirement_links for insert with check (true);
create policy "requirement_links_update_public" on public.requirement_links for update using (true) with check (true);
create policy "requirement_links_delete_public" on public.requirement_links for delete using (true);


-- ── amendments ──────────────────────────────────────────────
-- Had only SELECT and INSERT policies before this migration; the UPDATE and
-- DELETE below are new capability.
drop policy if exists "amendments_select_own" on public.amendments;
drop policy if exists "amendments_insert_own" on public.amendments;

create policy "amendments_select_public" on public.amendments for select using (true);
create policy "amendments_insert_public" on public.amendments for insert with check (true);
create policy "amendments_update_public" on public.amendments for update using (true) with check (true);
create policy "amendments_delete_public" on public.amendments for delete using (true);


-- ── fit_judgments ───────────────────────────────────────────
drop policy if exists "fit_judgments_select_own" on public.fit_judgments;
drop policy if exists "fit_judgments_insert_own" on public.fit_judgments;
drop policy if exists "fit_judgments_update_own" on public.fit_judgments;
drop policy if exists "fit_judgments_delete_own" on public.fit_judgments;

create policy "fit_judgments_select_public" on public.fit_judgments for select using (true);
create policy "fit_judgments_insert_public" on public.fit_judgments for insert with check (true);
create policy "fit_judgments_update_public" on public.fit_judgments for update using (true) with check (true);
create policy "fit_judgments_delete_public" on public.fit_judgments for delete using (true);


-- ── company_profile ─────────────────────────────────────────
-- The company_profile_singleton_idx unique index still holds: at most one row,
-- regardless of who may now write it.
drop policy if exists "company_profile_select_authenticated" on public.company_profile;
drop policy if exists "company_profile_write_authenticated" on public.company_profile;

create policy "company_profile_select_public" on public.company_profile for select using (true);
create policy "company_profile_insert_public" on public.company_profile for insert with check (true);
create policy "company_profile_update_public" on public.company_profile for update using (true) with check (true);
create policy "company_profile_delete_public" on public.company_profile for delete using (true);


-- ── content_library ─────────────────────────────────────────
drop policy if exists "content_library_select_authenticated" on public.content_library;
drop policy if exists "content_library_write_authenticated" on public.content_library;

create policy "content_library_select_public" on public.content_library for select using (true);
create policy "content_library_insert_public" on public.content_library for insert with check (true);
create policy "content_library_update_public" on public.content_library for update using (true) with check (true);
create policy "content_library_delete_public" on public.content_library for delete using (true);


-- ── rfp_files ───────────────────────────────────────────────
-- §7.1's per-file breakdown. pages/index.js writes these rows on a multi-file
-- upload, and the cross-file contradiction check reads them.
drop policy if exists "rfp_files_select_own" on public.rfp_files;
drop policy if exists "rfp_files_insert_own" on public.rfp_files;
drop policy if exists "rfp_files_update_own" on public.rfp_files;
drop policy if exists "rfp_files_delete_own" on public.rfp_files;

create policy "rfp_files_select_public" on public.rfp_files for select using (true);
create policy "rfp_files_insert_public" on public.rfp_files for insert with check (true);
create policy "rfp_files_update_public" on public.rfp_files for update using (true) with check (true);
create policy "rfp_files_delete_public" on public.rfp_files for delete using (true);


-- ── requirement_changes ─────────────────────────────────────
-- Amendment Tracking's stored diffs.
drop policy if exists "requirement_changes_select_own" on public.requirement_changes;
drop policy if exists "requirement_changes_write_own" on public.requirement_changes;

create policy "requirement_changes_select_public" on public.requirement_changes for select using (true);
create policy "requirement_changes_insert_public" on public.requirement_changes for insert with check (true);
create policy "requirement_changes_update_public" on public.requirement_changes for update using (true) with check (true);
create policy "requirement_changes_delete_public" on public.requirement_changes for delete using (true);


-- ── response_skeletons ──────────────────────────────────────
-- Response Builder's drafted answers.
drop policy if exists "response_skeletons_select_own" on public.response_skeletons;
drop policy if exists "response_skeletons_write_own" on public.response_skeletons;

create policy "response_skeletons_select_public" on public.response_skeletons for select using (true);
create policy "response_skeletons_insert_public" on public.response_skeletons for insert with check (true);
create policy "response_skeletons_update_public" on public.response_skeletons for update using (true) with check (true);
create policy "response_skeletons_delete_public" on public.response_skeletons for delete using (true);
