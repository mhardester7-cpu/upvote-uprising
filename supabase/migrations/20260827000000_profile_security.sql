-- Least-privilege grants and explicit per-operation policies for player data.
--
-- URL filters are chosen by the caller, so they are never an authorization
-- boundary. These policies run inside Postgres and compare every affected row
-- to the user id in the verified access token.

alter table public.profiles enable row level security;

revoke all privileges on table public.profiles from anon;
revoke all privileges on table public.profiles from authenticated;
grant select, insert, update on table public.profiles to authenticated;

-- A caller may edit only one row, but that row must not become an unbounded
-- storage payload. NOT VALID avoids breaking an upgrade because of an old bad
-- row while still enforcing the limits on every future insert or update.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_owned_skins_bounded'
  ) then
    alter table public.profiles
      add constraint profiles_owned_skins_bounded check (
        cardinality(owned_skins) between 1 and 64
        and octet_length(array_to_string(owned_skins, ',')) <= 4096
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_equipped_skin_bounded'
  ) then
    alter table public.profiles
      add constraint profiles_equipped_skin_bounded check (
        char_length(equipped_skin) between 1 and 64
      ) not valid;
  end if;
end
$$;

drop policy if exists "profiles are private to their owner" on public.profiles;
drop policy if exists "profiles select own row" on public.profiles;
drop policy if exists "profiles insert own row" on public.profiles;
drop policy if exists "profiles update own row" on public.profiles;

create policy "profiles select own row"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

create policy "profiles insert own row"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);

create policy "profiles update own row"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- The signup trigger needs elevated rights to create the new user's row. An
-- empty search path prevents a caller-created object from shadowing a name the
-- function intended to use.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
