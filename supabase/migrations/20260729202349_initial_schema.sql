-- Enable UUID generation (no-op if already present)
create extension if not exists pgcrypto;

-- ============================================================
-- profiles (per-user data, 1:1 with auth.users)
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- shared updated_at trigger function
-- ============================================================
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- rfps (one row per uploaded RFP, owned by the uploading user)
-- ============================================================
create table public.rfps (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  original_filename text,
  storage_path text,
  raw_text text,
  deadline date,
  status text not null default 'uploaded',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index rfps_owner_id_idx on public.rfps(owner_id);

alter table public.rfps enable row level security;

create policy "rfps_select_own"
  on public.rfps for select
  using (auth.uid() = owner_id);

create policy "rfps_insert_own"
  on public.rfps for insert
  with check (auth.uid() = owner_id);

create policy "rfps_update_own"
  on public.rfps for update
  using (auth.uid() = owner_id);

create policy "rfps_delete_own"
  on public.rfps for delete
  using (auth.uid() = owner_id);

create trigger rfps_set_updated_at
  before update on public.rfps
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- requirements (Module 1 output, one row per requirement)
-- ============================================================
create table public.requirements (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid not null references public.rfps(id) on delete cascade,
  req_number text not null,
  requirement_text text not null,
  page integer,
  section text,
  role text,
  department text,
  confidence numeric(3,2),
  created_at timestamptz not null default now(),
  unique (rfp_id, req_number)
);

create index requirements_rfp_id_idx on public.requirements(rfp_id);

alter table public.requirements enable row level security;

create policy "requirements_select_own"
  on public.requirements for select
  using (exists (
    select 1 from public.rfps
    where rfps.id = requirements.rfp_id
      and rfps.owner_id = auth.uid()
  ));

create policy "requirements_insert_own"
  on public.requirements for insert
  with check (exists (
    select 1 from public.rfps
    where rfps.id = requirements.rfp_id
      and rfps.owner_id = auth.uid()
  ));

create policy "requirements_update_own"
  on public.requirements for update
  using (exists (
    select 1 from public.rfps
    where rfps.id = requirements.rfp_id
      and rfps.owner_id = auth.uid()
  ));

create policy "requirements_delete_own"
  on public.requirements for delete
  using (exists (
    select 1 from public.rfps
    where rfps.id = requirements.rfp_id
      and rfps.owner_id = auth.uid()
  ));

-- ============================================================
-- requirement_links (§4.4 — linked requirements, not a table
-- named explicitly in the plan; added to normalize that relationship)
-- ============================================================
create table public.requirement_links (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirements(id) on delete cascade,
  linked_requirement_id uuid not null references public.requirements(id) on delete cascade,
  relationship_note text,
  created_at timestamptz not null default now(),
  check (requirement_id <> linked_requirement_id)
);

create index requirement_links_requirement_id_idx on public.requirement_links(requirement_id);

alter table public.requirement_links enable row level security;

create policy "requirement_links_select_own"
  on public.requirement_links for select
  using (exists (
    select 1 from public.requirements r
    join public.rfps on rfps.id = r.rfp_id
    where r.id = requirement_links.requirement_id
      and rfps.owner_id = auth.uid()
  ));

create policy "requirement_links_insert_own"
  on public.requirement_links for insert
  with check (exists (
    select 1 from public.requirements r
    join public.rfps on rfps.id = r.rfp_id
    where r.id = requirement_links.requirement_id
      and rfps.owner_id = auth.uid()
  ));

create policy "requirement_links_delete_own"
  on public.requirement_links for delete
  using (exists (
    select 1 from public.requirements r
    join public.rfps on rfps.id = r.rfp_id
    where r.id = requirement_links.requirement_id
      and rfps.owner_id = auth.uid()
  ));

-- ============================================================
-- company_profile (shared, company-wide — not per-user; §6.1)
-- ============================================================
create table public.company_profile (
  id uuid primary key default gen_random_uuid(),
  certificates jsonb not null default '[]'::jsonb,
  insurance_limit numeric,
  bonding_capacity numeric,
  registrations jsonb not null default '[]'::jsonb,
  staff jsonb not null default '[]'::jsonb,
  geography jsonb not null default '[]'::jsonb,
  past_projects jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.company_profile enable row level security;

create policy "company_profile_select_authenticated"
  on public.company_profile for select
  using (auth.role() = 'authenticated');

create policy "company_profile_write_authenticated"
  on public.company_profile for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create trigger company_profile_set_updated_at
  before update on public.company_profile
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- content_library (shared, company-wide reusable text blocks; §8.1)
-- ============================================================
create table public.content_library (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  title text not null,
  content text not null,
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.content_library enable row level security;

create policy "content_library_select_authenticated"
  on public.content_library for select
  using (auth.role() = 'authenticated');

create policy "content_library_write_authenticated"
  on public.content_library for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ============================================================
-- analyses (existing analysis output, migrating out of localStorage)
-- ============================================================
create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid not null references public.rfps(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  result jsonb not null,
  bid_score numeric(5,2),
  status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index analyses_rfp_id_idx on public.analyses(rfp_id);
create index analyses_owner_id_idx on public.analyses(owner_id);

alter table public.analyses enable row level security;

create policy "analyses_select_own"
  on public.analyses for select
  using (auth.uid() = owner_id);

create policy "analyses_insert_own"
  on public.analyses for insert
  with check (auth.uid() = owner_id);

create policy "analyses_update_own"
  on public.analyses for update
  using (auth.uid() = owner_id);

create policy "analyses_delete_own"
  on public.analyses for delete
  using (auth.uid() = owner_id);

create trigger analyses_set_updated_at
  before update on public.analyses
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- amendments (Module 5 — links an amended RFP to its original; §7.3/7.4)
-- ============================================================
create table public.amendments (
  id uuid primary key default gen_random_uuid(),
  original_rfp_id uuid not null references public.rfps(id) on delete cascade,
  amended_rfp_id uuid not null references public.rfps(id) on delete cascade,
  diff jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (original_rfp_id <> amended_rfp_id)
);

create index amendments_original_rfp_id_idx on public.amendments(original_rfp_id);
create index amendments_amended_rfp_id_idx on public.amendments(amended_rfp_id);

alter table public.amendments enable row level security;

create policy "amendments_select_own"
  on public.amendments for select
  using (exists (
    select 1 from public.rfps
    where rfps.id = amendments.original_rfp_id
      and rfps.owner_id = auth.uid()
  ));

create policy "amendments_insert_own"
  on public.amendments for insert
  with check (exists (
    select 1 from public.rfps
    where rfps.id = amendments.original_rfp_id
      and rfps.owner_id = auth.uid()
  ));
