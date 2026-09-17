-- Create user_card_tokens table for iVeri tokenized cards
create table if not exists public.user_card_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  partner_type text not null check (partner_type in ('RESTAURANT', 'STORE', 'GLOBAL')),
  restaurant_id uuid null references public.restaurants(id) on delete set null,
  store_id uuid null references public.stores(id) on delete set null,
  payment_provider text not null default 'IVERI_MERCHANT',
  transaction_index text not null, -- Opaque GUID token hash returned by iVeri
  initial_transaction_index text not null, -- Initial parent token reference
  masked_pan varchar(20) not null, -- Display-only masked card (e.g. 4242....4242)
  card_brand varchar(30) null, -- Non-sensitive brand (e.g. VISA, MASTERCARD)
  exp_month varchar(2) null,
  exp_year varchar(4) null,
  is_active boolean not null default true,
  is_default boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  last_used_at timestamptz null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint user_card_tokens_partner_chk check (
    (partner_type = 'RESTAURANT' and restaurant_id is not null and store_id is null) or
    (partner_type = 'STORE' and store_id is not null and restaurant_id is null) or
    (partner_type = 'GLOBAL' and restaurant_id is null and store_id is null)
  )
);

create index if not exists user_card_tokens_user_idx on public.user_card_tokens(user_id, is_active);
create index if not exists user_card_tokens_restaurant_idx on public.user_card_tokens(restaurant_id);
create index if not exists user_card_tokens_store_idx on public.user_card_tokens(store_id);
