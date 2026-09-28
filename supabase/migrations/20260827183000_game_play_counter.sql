-- One durable, global number of gameplay starts.
--
-- A play event contains only a random UUID generated for that run. It is not a
-- player or browser identifier and is stored only so network retries cannot
-- increment the total twice. The aggregate is public because it is displayed
-- on the front menu; there is no per-player data in either table.

create table if not exists public.game_stats (
  key        text primary key check (key = 'global'),
  plays      bigint not null default 0 check (plays >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_play_events (
  id         uuid primary key,
  started_at timestamptz not null default now()
);

insert into public.game_stats (key, plays)
values ('global', 0)
on conflict (key) do nothing;

alter table public.game_stats enable row level security;
alter table public.game_play_events enable row level security;

revoke all privileges on table public.game_stats from public, anon, authenticated;
revoke all privileges on table public.game_play_events from public, anon, authenticated;
grant select (key, plays, updated_at) on table public.game_stats to anon, authenticated;

drop policy if exists "global game stats are public" on public.game_stats;
create policy "global game stats are public"
  on public.game_stats for select to anon, authenticated
  using (key = 'global');

-- The function is the only write surface. SECURITY DEFINER is intentional: the
-- caller may submit an idempotency UUID, but cannot read events or choose the
-- counter value. The insert and increment are one transaction.
create or replace function public.record_game_play(p_run_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted integer;
  total bigint;
begin
  insert into public.game_play_events (id)
  values (p_run_id)
  on conflict (id) do nothing;

  get diagnostics inserted = row_count;

  if inserted = 1 then
    update public.game_stats
      set plays = plays + 1,
          updated_at = now()
      where key = 'global'
      returning plays into total;
  else
    select plays into total
      from public.game_stats
      where key = 'global';
  end if;

  return coalesce(total, 0);
end;
$$;

revoke all on function public.record_game_play(uuid) from public;
grant execute on function public.record_game_play(uuid) to anon, authenticated;
