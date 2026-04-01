alter table public.payment_sessions
  drop constraint if exists payment_sessions_entity_scope_chk;

alter table public.payment_sessions
  add constraint payment_sessions_entity_scope_chk check (
    (payment_context = 'BOOKING' and restaurant_id is not null and store_id is null) or
    (payment_context = 'BILL_PAYMENT' and ((restaurant_id is not null and store_id is null) or (restaurant_id is null and store_id is not null)))
  );

alter table public.bill_payments
  add column if not exists restaurant_id uuid null;

alter table public.bill_payments
  alter column store_id drop not null;

alter table public.bill_payments
  alter column item_id drop not null;

alter table public.bill_payments
  drop constraint if exists bill_payments_entity_scope_chk;

alter table public.bill_payments
  add constraint bill_payments_entity_scope_chk check (
    (restaurant_id is not null and store_id is null) or
    (restaurant_id is null and store_id is not null)
  );

create index if not exists bill_payments_restaurant_id_idx on public.bill_payments(restaurant_id);
