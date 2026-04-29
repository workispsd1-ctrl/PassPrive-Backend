alter table public.payment_sessions
  drop constraint if exists payment_sessions_payment_context_check;

alter table public.payment_sessions
  add constraint payment_sessions_payment_context_check check (
    payment_context = any (array['BOOKING'::text, 'BILL_PAYMENT'::text, 'MEMBERSHIP'::text, 'TABLE_ORDERS'::text])
  );

alter table public.payment_sessions
  drop constraint if exists payment_sessions_entity_scope_chk;

alter table public.payment_sessions
  add constraint payment_sessions_entity_scope_chk check (
    (
      (payment_context = 'BOOKING'::text)
      and (restaurant_id is not null)
      and (store_id is null)
    )
    or (
      (payment_context = 'BILL_PAYMENT'::text)
      and (
        (
          (restaurant_id is not null)
          and (store_id is null)
        )
        or (
          (restaurant_id is null)
          and (store_id is not null)
        )
      )
    )
    or (
      (payment_context = 'MEMBERSHIP'::text)
      and (restaurant_id is null)
      and (store_id is null)
    )
    or (
      (payment_context = 'TABLE_ORDERS'::text)
      and (restaurant_id is not null)
      and (store_id is null)
    )
  );
