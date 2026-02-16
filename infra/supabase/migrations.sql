-- Extensions
create extension if not exists "pgcrypto";

-- Tables
create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  twilio_number text unique not null,
  menu_json jsonb not null default '{"categories": []}'::jsonb,
  address text,
  created_at timestamptz not null default now()
);

create table if not exists public.restaurant_users (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'owner' check (role in ('owner','manager','admin')),
  created_at timestamptz not null default now(),
  unique (restaurant_id, user_id)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  customer_phone text not null,
  items_json jsonb not null,
  total_price numeric(10,2) not null,
  pickup_time text not null,
  status text not null default 'pending' check (status in ('pending','confirmed','completed','cancelled')),
  transcript text,
  ai_confidence numeric(3,2),
  created_at timestamptz not null default now()
);

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  twilio_call_sid text unique,
  duration_seconds int,
  transcript text,
  recording_url text,
  status text not null default 'in_progress' check (status in ('in_progress','completed','failed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_restaurant_users_user on public.restaurant_users(user_id);
create index if not exists idx_orders_restaurant_created on public.orders(restaurant_id, created_at desc);
create index if not exists idx_calls_restaurant_created on public.calls(restaurant_id, created_at desc);

-- RLS
alter table public.restaurants enable row level security;
alter table public.restaurant_users enable row level security;
alter table public.orders enable row level security;
alter table public.calls enable row level security;

-- Helper policy condition via EXISTS on membership
create policy "restaurant users can view own restaurant"
on public.restaurants for select
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = restaurants.id and ru.user_id = auth.uid()
  )
);

create policy "restaurant users can update own restaurant"
on public.restaurants for update
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = restaurants.id and ru.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = restaurants.id and ru.user_id = auth.uid()
  )
);

create policy "user can view own memberships"
on public.restaurant_users for select
using (user_id = auth.uid());

create policy "restaurant members view orders"
on public.orders for select
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = orders.restaurant_id and ru.user_id = auth.uid()
  )
);

create policy "restaurant members insert orders"
on public.orders for insert
with check (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = orders.restaurant_id and ru.user_id = auth.uid()
  )
);

create policy "restaurant members update orders"
on public.orders for update
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = orders.restaurant_id and ru.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = orders.restaurant_id and ru.user_id = auth.uid()
  )
);

create policy "restaurant members view calls"
on public.calls for select
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = calls.restaurant_id and ru.user_id = auth.uid()
  )
);

create policy "restaurant members insert calls"
on public.calls for insert
with check (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = calls.restaurant_id and ru.user_id = auth.uid()
  )
);

create policy "restaurant members update calls"
on public.calls for update
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = calls.restaurant_id and ru.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = calls.restaurant_id and ru.user_id = auth.uid()
  )
);
