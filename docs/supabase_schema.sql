-- TimeWellSpent Supabase schema (baseline)

create table if not exists devices (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  platform text not null,
  last_seen_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  handle text unique,
  display_name text,
  color text,
  pinned_trophies text[] default array[]::text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references auth.users(id) on delete cascade not null,
  recipient_id uuid references auth.users(id) on delete cascade not null,
  status text check (status in ('pending','accepted','declined','canceled')) not null default 'pending',
  created_at timestamptz default now(),
  responded_at timestamptz
);

create table if not exists friends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  friend_id uuid references auth.users(id) on delete cascade not null,
  created_at timestamptz default now()
);

create unique index if not exists friends_pair_unique on friends (user_id, friend_id);

create table if not exists wallet_transactions (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete cascade default auth.uid(),
  device_id uuid references devices(id) on delete set null,
  ts timestamptz not null,
  type text check (type in ('earn','spend','adjust')) not null,
  amount integer not null,
  meta jsonb default '{}'::jsonb
);

create table if not exists library_items (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete cascade default auth.uid(),
  device_id uuid references devices(id) on delete set null,
  kind text check (kind in ('url','app')) not null,
  url text,
  app text,
  domain text not null,
  title text,
  note text,
  purpose text not null,
  price integer,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  last_used_at timestamptz,
  consumed_at timestamptz,
  deleted_at timestamptz
);

create table if not exists consumption_log (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete cascade default auth.uid(),
  device_id uuid references devices(id) on delete set null,
  occurred_at timestamptz not null,
  kind text not null,
  title text,
  url text,
  domain text,
  meta jsonb default '{}'::jsonb
);

create table if not exists activity_rollups (
  device_id uuid references devices(id) on delete cascade,
  hour_start timestamptz not null,
  productive integer not null,
  neutral integer not null,
  frivolity integer not null,
  idle integer not null,
  updated_at timestamptz not null,
  primary key (device_id, hour_start)
);

create table if not exists trophies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade default auth.uid(),
  trophy_id text not null,
  earned_at timestamptz not null,
  meta jsonb default '{}'::jsonb
);

create unique index if not exists trophies_user_unique on trophies (user_id, trophy_id);

-- RLS policies (user_id must match auth.uid())
alter table devices enable row level security;
alter table profiles enable row level security;
alter table friend_requests enable row level security;
alter table friends enable row level security;
alter table wallet_transactions enable row level security;
alter table library_items enable row level security;
alter table consumption_log enable row level security;
alter table activity_rollups enable row level security;
alter table trophies enable row level security;

create policy "devices own rows" on devices
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "devices friends read" on devices
  for select using (
    user_id in (
      select case
        when user_id = auth.uid() then friend_id
        else user_id
      end
      from friends
      where user_id = auth.uid() or friend_id = auth.uid()
    )
  );
create policy "profiles public read" on profiles
  for select using (true);
create policy "profiles own rows" on profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "friend requests participant access" on friend_requests
  for all using (requester_id = auth.uid() or recipient_id = auth.uid())
  with check (requester_id = auth.uid() or recipient_id = auth.uid());
create policy "friends participant access" on friends
  for all using (user_id = auth.uid() or friend_id = auth.uid())
  with check (user_id = auth.uid() or friend_id = auth.uid());
create policy "wallet own rows" on wallet_transactions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "library own rows" on library_items
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "consumption own rows" on consumption_log
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "rollups own rows" on activity_rollups
  for all using (device_id in (select id from devices where user_id = auth.uid())) with check (device_id in (select id from devices where user_id = auth.uid()));
create policy "rollups friends read" on activity_rollups
  for select using (
    device_id in (
      select id from devices
      where user_id in (
        select case
          when user_id = auth.uid() then friend_id
          else user_id
        end
        from friends
        where user_id = auth.uid() or friend_id = auth.uid()
      )
    )
  );

create policy "trophies own rows" on trophies
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
