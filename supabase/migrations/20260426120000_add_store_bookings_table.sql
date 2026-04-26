create extension if not exists "pgcrypto";

create table if not exists public.store_bookings (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  customer_user_id uuid not null,
  customer_name text null,
  customer_phone text null,
  customer_email text null,
  booking_date date not null,
  booking_time time not null,
  duration_minutes integer not null default 30,
  status text not null default 'pending',
  source text not null default 'app',
  special_request text null,
  booking_code text null,
  read boolean not null default false,
  customer_booking_number integer not null default 1,
  selected_offer jsonb null,
  payment_required boolean not null default false,
  cover_charge_required boolean not null default false,
  cover_charge_amount numeric(12, 2) not null default 0,
  payment_amount numeric(12, 2) not null default 0,
  payment_status text null,
  payment_method text null,
  payment_reference text null,
  booked_slot_label text null,
  services jsonb not null default '[]'::jsonb,
  service_details jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  cancelled_at timestamptz null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists store_bookings_store_id_idx on public.store_bookings(store_id);
create index if not exists store_bookings_customer_user_id_idx on public.store_bookings(customer_user_id);
create index if not exists store_bookings_booking_slot_idx on public.store_bookings(store_id, booking_date, booking_time);
create index if not exists store_bookings_status_idx on public.store_bookings(status);
