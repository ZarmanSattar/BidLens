-- ============================================================
-- Drop the owner_id → auth.users foreign keys
-- ============================================================
-- Follow-up to 20260915000000_relax_rls_no_auth.sql. That migration made the
-- policies pass without a session; this one makes the writes themselves legal.
--
-- public.rfps and public.analyses both declare:
--
--   owner_id uuid not null references auth.users(id) on delete cascade
--
-- With login removed, the app writes a placeholder owner id
-- (lib/placeholderOwner.js, 00000000-0000-0000-0000-000000000000) because the
-- column is still NOT NULL and there is no session to take a real id from. That
-- UUID is not a row in auth.users, so every insert fails the foreign key even
-- though RLS now allows it. Dropping the constraint is what lets the placeholder
-- through.
--
-- owner_id stays NOT NULL and keeps its type, its values and its indexes
-- (rfps_owner_id_idx, analyses_owner_id_idx). The only thing removed is the
-- referential check against auth.users. The column becomes an opaque uuid that
-- no longer has to name a real user — which is the accurate description of what
-- it holds now.
--
-- WHAT ELSE GOES WITH IT. The constraints carried "on delete cascade", so
-- deleting an auth.users row used to delete that user's rfps (and, through
-- rfps, everything keyed to them). That cleanup path is gone. It is moot in
-- practice — signup was removed, so no new auth.users rows are created and none
-- are expected to be deleted — but if you ever reintroduce auth and start
-- deleting users, their RFP rows will now be left behind. The FK on
-- analyses.rfp_id → public.rfps(id) is untouched, so deleting an rfp still
-- cascades to its analyses exactly as before.
--
-- public.profiles.id also references auth.users(id), and is deliberately left
-- alone: it is not an owner_id, no application code queries the table, and its
-- rows only exist for users that the handle_new_user trigger created.
--
-- The constraints were declared inline and never named, so they carry the names
-- Postgres generates by default: <table>_<column>_fkey. Those are dropped by
-- name below. The DO block that follows is a safety net for a database where
-- the constraint ended up under some other name (restored from a dump, renamed
-- by hand): it finds any remaining foreign key on owner_id that points at
-- auth.users and drops that too, so this migration is correct regardless of
-- naming. Both forms are idempotent and safe to re-run.

alter table public.rfps
  drop constraint if exists rfps_owner_id_fkey;

alter table public.analyses
  drop constraint if exists analyses_owner_id_fkey;


-- Safety net: catch any owner_id → auth.users foreign key that survived the
-- two drops above under a non-default name.
do $$
declare
  target record;
begin
  for target in
    select
      con.conrelid::regclass as table_name,
      con.conname            as constraint_name
    from pg_constraint con
    join pg_class  child  on child.oid  = con.conrelid
    join pg_class  parent on parent.oid = con.confrelid
    join pg_namespace child_ns  on child_ns.oid  = child.relnamespace
    join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    where con.contype = 'f'
      and child_ns.nspname  = 'public'
      and child.relname     in ('rfps', 'analyses')
      and parent_ns.nspname = 'auth'
      and parent.relname    = 'users'
      -- Single-column key, and that column is owner_id. Written as a scalar
      -- lookup on conkey[1] rather than an array comparison so there is no
      -- name[] vs text[] cast to get wrong.
      and array_length(con.conkey, 1) = 1
      and (
        select att.attname
        from pg_attribute att
        where att.attrelid = con.conrelid
          and att.attnum   = con.conkey[1]
      ) = 'owner_id'
  loop
    raise notice
      'dropping leftover owner_id -> auth.users constraint %.%',
      target.table_name, target.constraint_name;

    execute format(
      'alter table %s drop constraint %I',
      target.table_name, target.constraint_name
    );
  end loop;
end
$$;


comment on column public.rfps.owner_id is
  'Opaque uuid, no longer references auth.users. Login was removed, so this holds the placeholder id from lib/placeholderOwner.js.';

comment on column public.analyses.owner_id is
  'Opaque uuid, no longer references auth.users. Login was removed, so this holds the placeholder id from lib/placeholderOwner.js.';
