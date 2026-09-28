-- Historical migration retained so databases that already applied it keep a
-- valid migration chain. The public launch no longer has monetization and the
-- later 20260827001000 migration removes this table.

create table if not exists public.entitlements (
  id           bigserial   primary key,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  product      text        not null,
  session_id   text        not null unique,
  amount_cents integer     not null check (amount_cents >= 0),
  currency     text        not null default 'usd',
  created_at   timestamptz not null default now()
);

create index if not exists entitlements_user_idx on public.entitlements (user_id);
create unique index if not exists entitlements_user_product_idx
  on public.entitlements (user_id, product);

alter table public.entitlements enable row level security;

drop policy if exists "entitlements are readable by their owner" on public.entitlements;
create policy "entitlements are readable by their owner"
  on public.entitlements
  for select
  using (auth.uid() = user_id);
