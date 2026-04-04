alter table public.payment_sessions
  add column if not exists discount_source text not null default 'NONE',
  add column if not exists discount_code text null,
  add column if not exists discount_name text null,
  add column if not exists discount_meta jsonb not null default '{}'::jsonb;

alter table public.payment_sessions
  drop constraint if exists payment_sessions_discount_source_check;

alter table public.payment_sessions
  add constraint payment_sessions_discount_source_check check (
    discount_source = any (
      array[
        'NONE'::text,
        'BANK'::text,
        'PLATFORM'::text,
        'PARTNER'::text
      ]
    )
  );

create index if not exists payment_sessions_discount_source_idx
  on public.payment_sessions (discount_source);

create index if not exists payment_sessions_discount_code_idx
  on public.payment_sessions (discount_code);
