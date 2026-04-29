alter table public.payment_sessions
  add column if not exists finalized_booking_id uuid null;

create unique index if not exists payment_sessions_finalized_booking_id_uq_idx
  on public.payment_sessions (finalized_booking_id)
  where finalized_booking_id is not null;
