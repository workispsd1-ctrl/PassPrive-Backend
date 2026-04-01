create extension if not exists "pgcrypto";

create table if not exists public.payment_sessions (
  id uuid primary key default gen_random_uuid(),
  payment_provider text not null,
  payment_context text not null check (payment_context in ('BOOKING', 'BILL_PAYMENT')),
  context_reference_id uuid null,
  user_id uuid not null,
  restaurant_id uuid null,
  store_id uuid null,
  merchant_trace varchar(64) not null unique,
  merchant_application_id varchar(64) not null,
  amount_major numeric(12, 2) not null,
  amount_minor integer not null,
  currency_code varchar(3) not null default 'MUR',
  discount_amount numeric(12, 2) not null default 0,
  cashback_amount numeric(12, 2) not null default 0,
  original_amount numeric(12, 2) not null default 0,
  status text not null check (status in ('CREATED', 'PENDING', 'RETURNED', 'VERIFIED_SUCCESS', 'VERIFIED_FAILED', 'FINALIZED', 'CANCELLED', 'ERROR')),
  gateway_status text null,
  gateway_result_code text null,
  gateway_result_description text null,
  transaction_index text null,
  authorization_code text null,
  bank_reference text null,
  gateway_payload jsonb not null default '{}'::jsonb,
  verified_at timestamptz null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint payment_sessions_entity_scope_chk check (
    (payment_context = 'BOOKING' and restaurant_id is not null and store_id is null) or
    (payment_context = 'BILL_PAYMENT' and ((restaurant_id is not null and store_id is null) or (restaurant_id is null and store_id is not null)))
  )
);

create index if not exists payment_sessions_user_id_idx on public.payment_sessions(user_id);
create index if not exists payment_sessions_context_idx on public.payment_sessions(payment_context, status);
create index if not exists payment_sessions_restaurant_id_idx on public.payment_sessions(restaurant_id);
create index if not exists payment_sessions_store_id_idx on public.payment_sessions(store_id);

create table if not exists public.bill_payments (
  id uuid primary key default gen_random_uuid(),
  payment_session_id uuid not null unique references public.payment_sessions(id) on delete cascade,
  user_id uuid not null,
  restaurant_id uuid null,
  store_id uuid null,
  item_id uuid null,
  quantity integer not null,
  currency_code varchar(3) not null default 'MUR',
  original_amount numeric(12, 2) not null,
  discount_amount numeric(12, 2) not null default 0,
  cashback_amount numeric(12, 2) not null default 0,
  final_paid_amount numeric(12, 2) not null,
  payment_provider text not null default 'IVERI',
  gateway_transaction_index text null,
  gateway_authorization_code text null,
  gateway_bank_reference text null,
  status text not null default 'PAID',
  offer_breakdown jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint bill_payments_entity_scope_chk check (
    (restaurant_id is not null and store_id is null) or
    (restaurant_id is null and store_id is not null)
  )
);

create index if not exists bill_payments_user_id_idx on public.bill_payments(user_id);
create index if not exists bill_payments_restaurant_id_idx on public.bill_payments(restaurant_id);
create index if not exists bill_payments_store_id_idx on public.bill_payments(store_id);
