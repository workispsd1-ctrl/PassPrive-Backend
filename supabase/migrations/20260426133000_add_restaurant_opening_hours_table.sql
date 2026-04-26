create extension if not exists "pgcrypto";

create table if not exists public.restaurant_opening_hours (
  id uuid not null default gen_random_uuid(),
  restaurant_id uuid not null,
  day_of_week integer not null,
  open_time time without time zone null,
  close_time time without time zone null,
  is_closed boolean not null default false,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint restaurant_opening_hours_pkey primary key (id),
  constraint restaurant_opening_hours_restaurant_id_fkey foreign key (restaurant_id) references restaurants (id) on delete cascade,
  constraint restaurant_opening_hours_day_of_week_chk check (
    ((day_of_week >= 0) and (day_of_week <= 6))
  ),
  constraint restaurant_opening_hours_time_order_chk check (
    ((is_closed = true) or (open_time <> close_time))
  ),
  constraint restaurant_opening_hours_time_required_chk check (
    (
      ((is_closed = true) and (open_time is null) and (close_time is null))
      or
      ((is_closed = false) and (open_time is not null) and (close_time is not null))
    )
  )
) tablespace pg_default;

create index if not exists restaurant_opening_hours_restaurant_id_idx on public.restaurant_opening_hours using btree (restaurant_id) tablespace pg_default;

create index if not exists restaurant_opening_hours_restaurant_day_idx on public.restaurant_opening_hours using btree (restaurant_id, day_of_week) tablespace pg_default;

create unique index if not exists restaurant_opening_hours_restaurant_day_unique_idx on public.restaurant_opening_hours using btree (restaurant_id, day_of_week) tablespace pg_default;

drop trigger if exists trg_restaurant_opening_hours_set_updated_at on restaurant_opening_hours;
create trigger trg_restaurant_opening_hours_set_updated_at before update on restaurant_opening_hours for each row
execute function set_updated_at();
