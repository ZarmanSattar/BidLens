-- ============================================================
-- company_profile — enforce the singleton the design already assumed
-- ============================================================
-- The table itself landed in the initial schema (§6.1) with company-wide RLS
-- (auth.role() = 'authenticated') rather than the owner_id scoping every other
-- table uses. That was deliberate: there is one company, so there is one
-- profile. Nothing enforced it, though — a second insert would succeed and
-- every reader would then be picking a row arbitrarily.
--
-- A unique index on a constant expression is the standard way to say "at most
-- one row" in Postgres: every row indexes the same key, so the second insert
-- collides. Preferred over a `check (id = '<fixed uuid>')` because it needs no
-- magic constant, and over an application-level guard because the API route is
-- not the only thing that can write here.
--
-- No column changes. The existing columns already cover §6.1 in full
-- (certificates, insurance_limit, bonding_capacity, registrations, staff,
-- geography, past_projects), so the settings page and the §6.2 blocker checks
-- work against the table as it stands today, with or without this migration
-- applied.

create unique index if not exists company_profile_singleton_idx
  on public.company_profile ((true));

comment on index public.company_profile_singleton_idx is
  'At most one company_profile row. §6.2/§6.3 read "the" profile, not "a" profile.';
