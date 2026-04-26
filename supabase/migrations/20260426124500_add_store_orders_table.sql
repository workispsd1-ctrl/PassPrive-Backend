create extension if not exists "pgcrypto";

create table if not exists public.store_orders (
  id uuid not null default gen_random_uuid(),
  order_no text not null,
  store_id uuid not null,
  customer_name text null,
  customer_phone text null,
  customer_email text null,
  delivery_address text null,
  notes text null,
  items jsonb not null default '[]'::jsonb,
  subtotal numeric null,
  delivery_fee numeric null default 0,
  tax_amount numeric null default 0,
  discount_amount numeric null default 0,
  total_amount numeric not null default 0,
  payment_method text null default 'COD'::text,
  payment_status text not null default 'PENDING'::text,
  status text not null default 'NEW'::text,
  accepted_at timestamp with time zone null,
  rejected_at timestamp with time zone null,
  delivered_at timestamp with time zone null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  order_flow text not null default 'BASIC'::text,
  service_type text not null default 'PICKUP'::text,
  partner_seen_at timestamp with time zone null,
  scheduled_for timestamp with time zone null,
  slot_start_at timestamp with time zone null,
  slot_end_at timestamp with time zone null,
  selected_item_in_store boolean not null default false,
  customer_user_id uuid null,
  constraint store_orders_pkey primary key (id),
  constraint store_orders_order_no_key unique (order_no),
  constraint store_orders_store_id_fkey foreign key (store_id) references stores (id) on delete cascade,
  constraint store_orders_customer_user_id_fkey foreign key (customer_user_id) references auth.users (id) on delete set null,
  constraint store_orders_order_flow_chk check (
    (order_flow = any (array['BASIC'::text, 'PREMIUM'::text]))
  ),
  constraint store_orders_service_type_chk check (
    (service_type = any (array['PICKUP'::text, 'APPOINTMENT'::text]))
  ),
  constraint store_orders_status_chk check (
    (
      status = any (
        array[
          'NEW'::text,
          'PLACED'::text,
          'ACCEPTED'::text,
          'PREPARING'::text,
          'READY'::text,
          'OUT_FOR_DELIVERY'::text,
          'DELIVERED'::text,
          'REJECTED'::text,
          'CANCELLED'::text
        ]
      )
    )
  ),
  constraint store_orders_payment_status_chk check (
    (
      payment_status = any (
        array[
          'PENDING'::text,
          'PAID'::text,
          'FAILED'::text,
          'REFUNDED'::text
        ]
      )
    )
  )
) tablespace pg_default;

create index if not exists store_orders_store_unseen_idx on public.store_orders using btree (
  store_id,
  partner_seen_at,
  status,
  created_at desc
) tablespace pg_default;

create index if not exists store_orders_service_type_idx on public.store_orders using btree (service_type, status, created_at desc) tablespace pg_default;

create index if not exists store_orders_slot_idx on public.store_orders using btree (store_id, slot_start_at, slot_end_at) tablespace pg_default;

create index if not exists store_orders_store_id_idx on public.store_orders using btree (store_id) tablespace pg_default;

create index if not exists store_orders_status_idx on public.store_orders using btree (status) tablespace pg_default;

create index if not exists store_orders_created_at_idx on public.store_orders using btree (created_at desc) tablespace pg_default;

create index if not exists store_orders_store_status_created_idx on public.store_orders using btree (store_id, status, created_at desc) tablespace pg_default;

drop trigger if exists trg_store_orders_set_updated_at on store_orders;
create trigger trg_store_orders_set_updated_at before update on store_orders for each row
execute function set_updated_at();
