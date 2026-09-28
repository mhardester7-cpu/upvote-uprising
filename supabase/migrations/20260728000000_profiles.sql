-- BLOCKSTRIKE player profiles.
--
-- Applied by `supabase db push`, or by the GitHub integration on push. Every
-- statement is written to be re-runnable, so applying it twice is harmless.
--
-- One row per player, keyed by the auth user id. Row-level security is what
-- actually protects the data: the anon key shipped in the client is public, so
-- every policy below is written on the assumption that the client is hostile.

create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  credits       integer     not null default 0 check (credits >= 0),
  owned_skins   text[]      not null default array['default'],
  equipped_skin text        not null default 'default',
  best_score    integer     not null default 0 check (best_score >= 0),
  best_wave     integer     not null default 0 check (best_wave >= 0),
  total_kills   integer     not null default 0 check (total_kills >= 0),
  runs          integer     not null default 0 check (runs >= 0),
  updated_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A player may only ever see and write their own row. `auth.uid()` is taken
-- from the JWT, so a client cannot claim someone else's id by asking nicely.
drop policy if exists "profiles are private to their owner" on public.profiles;
create policy "profiles are private to their owner"
  on public.profiles
  for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Give every new account a row automatically, so the first save is an update
-- rather than a race between two clients both trying to insert.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- NOTE ON TRUST
--
-- Credits and unlocks are written by the client, so a determined player can
-- edit them in devtools. That is a deliberate trade: this is a single-player
-- score attack with cosmetic unlocks, and the alternative -- validating runs
-- server-side -- costs far more than the cheating is worth. Do not reuse this
-- table's shape for anything competitive or paid without moving the awarding
-- of credits into an edge function.
