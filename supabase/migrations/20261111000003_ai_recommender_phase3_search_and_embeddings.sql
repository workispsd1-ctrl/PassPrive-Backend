-- Migration: Phase 3 - Fast Search & Vector Engine (restaurant_search & embedding_jobs)
-- Description:
--   1. Creates `public.restaurant_search` as the denormalized, high-speed retrieval table.
--   2. Adds PostGIS geography point, GIN indexes (tags & name), and HNSW vector index (1536 dim).
--   3. Creates `public.embedding_jobs` queue for asynchronous OpenAI vector generation.
--   4. Adds `rebuild_restaurant_search_record` helper function and runs initial hydration for active venues.

-- 1. CREATE restaurant_search TABLE
create table if not exists public.restaurant_search (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  name text not null,
  city text not null,
  area text,
  full_address text,
  latitude double precision,
  longitude double precision,
  geog geography(point, 4326),
  currency char(3) not null default 'MUR',
  cost_for_two numeric(10,2),
  price_band text check (price_band in ('budget', 'mid', 'premium', 'luxury')),
  rating_avg real not null default 0,
  rating_count int not null default 0,
  bookings_30d int not null default 0,
  tag_keys text[] not null default '{}',    -- E.g. ARRAY['mood:romantic', 'cuisine:french']
  tag_weights jsonb not null default '{}',  -- E.g. '{"mood:romantic": 1.0, "cuisine:french": 0.6}'
  top_dishes jsonb not null default '[]',   -- Precomputed top 6 dishes
  has_offer boolean not null default false,
  is_active boolean not null default true,
  embedding vector(1536),                   -- OpenAI text-embedding-3-small
  embedding_model text,                     -- E.g. 'text-embedding-3-small'
  embedding_hash text,                      -- Hash of source text to detect changes
  embedded_at timestamptz,
  updated_at timestamptz not null default now()
);

-- 2. CREATE embedding_jobs TABLE (Queue for background embedding generator)
create table if not exists public.embedding_jobs (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  queued_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text
);

-- 3. SEARCH & VECTOR INDEXES
-- Filtered index on city and price band
create index if not exists idx_rs_city_band
  on public.restaurant_search (city, price_band)
  where is_active;

-- GIN index for rapid tag matching: tag_keys @> ARRAY['mood:romantic'] or tag_keys && :soft_tags
create index if not exists idx_rs_tags
  on public.restaurant_search using gin (tag_keys);

-- GiST index for spatial queries and distance sorting
create index if not exists idx_rs_geog
  on public.restaurant_search using gist (geog);

-- Trigram index for restaurant name search
create index if not exists idx_rs_name_trgm
  on public.restaurant_search using gin (name gin_trgm_ops);

-- Trigram and equality indexes for area-wise searches (e.g. "Grand Baie", "Tamarin")
create index if not exists idx_rs_area
  on public.restaurant_search (city, area)
  where is_active;

create index if not exists idx_rs_area_trgm
  on public.restaurant_search using gin (area gin_trgm_ops);

-- HNSW vector cosine distance index for semantic similarity
create index if not exists idx_rs_embedding
  on public.restaurant_search using hnsw (embedding vector_cosine_ops);

-- 4. FUNCTION TO REBUILD/HYDRATE A RESTAURANT_SEARCH RECORD
create or replace function public.rebuild_restaurant_search_record(target_restaurant_id uuid)
returns void
language plpgsql
as $$
declare
  r record;
  calc_geog geography(point, 4326) := null;
  calc_latitude double precision := null;
  calc_longitude double precision := null;
  calc_price_band text;
  calc_tags text[] := '{}';
  calc_weights jsonb := '{}'::jsonb;
  calc_top_dishes jsonb := '[]'::jsonb;
  calc_rating_avg real := 0;
  calc_rating_count int := 0;
  calc_bookings_30d int := 0;
  calc_has_offer boolean := false;
  calc_currency text := 'MUR';
  calc_city text := 'All';
  tag_rec record;
begin
  -- Fetch restaurant base details
  select * into r
  from public.restaurants
  where id = target_restaurant_id;

  if not found then
    delete from public.restaurant_search where restaurant_id = target_restaurant_id;
    return;
  end if;

  -- Resolve currency and city dynamically from restaurant record if available
  calc_currency := coalesce(nullif(trim(to_jsonb(r)->>'currency'), ''), 'MUR');
  calc_city := coalesce(nullif(trim(to_jsonb(r)->>'city'), ''), 'All');

  -- Extract coordinates from restaurants and compute PostGIS geography point
  if r.latitude is not null and r.longitude is not null then
    calc_latitude := r.latitude::double precision;
    calc_longitude := r.longitude::double precision;
    if calc_latitude between -90 and 90 and calc_longitude between -180 and 180 then
      calc_geog := st_setsrid(st_makepoint(calc_longitude, calc_latitude), 4326)::geography;
    end if;
  end if;

  -- Determine price band based on cost_for_two (aligned with PassPrive MUR brackets)
  if r.cost_for_two is not null then
    if r.cost_for_two <= 400 then
      calc_price_band := 'budget';
    elsif r.cost_for_two <= 900 then
      calc_price_band := 'mid';
    elsif r.cost_for_two <= 1600 then
      calc_price_band := 'premium';
    else
      calc_price_band := 'luxury';
    end if;
  else
    calc_price_band := 'mid';
  end if;

  -- Aggregate tags and weights from restaurant_tags
  for tag_rec in
    select
      lower(trim(tag_type)) as t_type,
      lower(trim(tag_value)) as t_val,
      coalesce(is_primary, false) as is_pri
    from public.restaurant_tags
    where restaurant_id = target_restaurant_id
      and nullif(trim(tag_value), '') is not null
  loop
    declare
      k text := tag_rec.t_type || ':' || lower(regexp_replace(regexp_replace(tag_rec.t_val, '[^a-zA-Z0-9]+', '_', 'g'), '(^_|_$)', '', 'g'));
      w numeric := case when tag_rec.is_pri then 1.0 else 0.6 end;
    begin
      calc_tags := array_append(calc_tags, k);
      calc_weights := jsonb_set(calc_weights, array[k], to_jsonb(w));
    end;
  end loop;

  -- Aggregate top 6 dishes from menu_items
  select coalesce(jsonb_agg(dish), '[]'::jsonb) into calc_top_dishes
  from (
    select jsonb_build_object(
      'id', id,
      'name', name,
      'course', course,
      'section', section,
      'price', price,
      'is_veg', is_veg,
      'is_bestseller', is_bestseller,
      'is_signature', is_signature,
      'tag', case when is_bestseller then 'bestseller' when is_signature then 'signature' else null end
    ) as dish
    from public.menu_items
    where restaurant_id = target_restaurant_id
      and is_available = true
    order by rank_score desc, is_bestseller desc, is_signature desc, created_at desc
    limit 6
  ) sub;

  -- Rating stats from restaurant_reviews
  select
    coalesce(round(avg(rating)::numeric, 1), 0)::real,
    count(*)::int
  into calc_rating_avg, calc_rating_count
  from public.restaurant_reviews
  where restaurant_id = target_restaurant_id
    and is_approved = true;

  -- Bookings count in last 30 days from restaurant_bookings
  select count(*)::int into calc_bookings_30d
  from public.restaurant_bookings
  where restaurant_id = target_restaurant_id
    and created_at >= (now() - interval '30 days')
    and status in ('confirmed', 'seated', 'completed');

  -- Active offer presence check from restaurant_offers
  select exists (
    select 1
    from public.restaurant_offers
    where restaurant_id = target_restaurant_id
      and is_active = true
      and (start_at is null or start_at <= now())
      and (end_at is null or end_at >= now())
  ) into calc_has_offer;

  -- Upsert into restaurant_search preserving existing embedding fields
  insert into public.restaurant_search (
    restaurant_id,
    name,
    city,
    area,
    full_address,
    latitude,
    longitude,
    geog,
    currency,
    cost_for_two,
    price_band,
    rating_avg,
    rating_count,
    bookings_30d,
    tag_keys,
    tag_weights,
    top_dishes,
    has_offer,
    is_active,
    updated_at
  ) values (
    target_restaurant_id,
    r.name,
    calc_city,
    nullif(trim(r.area), ''),
    nullif(trim(r.full_address), ''),
    calc_latitude,
    calc_longitude,
    calc_geog,
    calc_currency,
    r.cost_for_two,
    calc_price_band,
    calc_rating_avg,
    calc_rating_count,
    calc_bookings_30d,
    calc_tags,
    calc_weights,
    calc_top_dishes,
    calc_has_offer,
    coalesce(r.is_active, true),
    now()
  )
  on conflict (restaurant_id) do update set
    name = excluded.name,
    city = excluded.city,
    area = excluded.area,
    full_address = excluded.full_address,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    geog = excluded.geog,
    currency = excluded.currency,
    cost_for_two = excluded.cost_for_two,
    price_band = excluded.price_band,
    rating_avg = excluded.rating_avg,
    rating_count = excluded.rating_count,
    bookings_30d = excluded.bookings_30d,
    tag_keys = excluded.tag_keys,
    tag_weights = excluded.tag_weights,
    top_dishes = excluded.top_dishes,
    has_offer = excluded.has_offer,
    is_active = excluded.is_active,
    updated_at = now();

  -- Queue an embedding job if vector is missing or needs refresh
  insert into public.embedding_jobs (restaurant_id, queued_at, attempts)
  values (target_restaurant_id, now(), 0)
  on conflict (restaurant_id) do nothing;
end;
$$;

-- 5. INITIAL ONE-TIME HYDRATION FOR ALL ACTIVE RESTAURANTS
do $$
declare
  rec record;
begin
  for rec in select id from public.restaurants where is_active = true loop
    perform public.rebuild_restaurant_search_record(rec.id);
  end loop;
end $$;

-- 6. AUTOMATIC DATABASE TRIGGERS FOR CONTINUOUS DATA UPDATES
-- Trigger function: runs automatically whenever relevant venue data changes
create or replace function public.trigger_restaurant_data_changed()
returns trigger
language plpgsql
as $$
declare
  target_id uuid;
begin
  if (TG_OP = 'DELETE') then
    target_id := coalesce(OLD.restaurant_id, OLD.id);
  else
    target_id := coalesce(NEW.restaurant_id, NEW.id);
  end if;

  if target_id is not null then
    -- 1. Refresh search facts (name, area, top dishes, rating, price band)
    perform public.rebuild_restaurant_search_record(target_id);

    -- 2. Enqueue for vector embedding update
    insert into public.embedding_jobs (restaurant_id, queued_at, attempts)
    values (target_id, now(), 0)
    on conflict (restaurant_id) do update set queued_at = now();
  end if;

  return coalesce(NEW, OLD);
end;
$$;

-- Trigger A: on restaurants table (when profile, location, cost, or menu_json changes)
drop trigger if exists trg_restaurant_search_update on public.restaurants;
create trigger trg_restaurant_search_update
  after insert or update of name, area, city, full_address, latitude, longitude, cost_for_two, is_active, menu_json
  on public.restaurants
  for each row
  execute function public.trigger_restaurant_data_changed();

-- Trigger B: on restaurant_tags table (when mood, cuisine, or facility tags change)
drop trigger if exists trg_restaurant_tags_search_update on public.restaurant_tags;
create trigger trg_restaurant_tags_search_update
  after insert or update or delete
  on public.restaurant_tags
  for each row
  execute function public.trigger_restaurant_data_changed();

-- Trigger C: on menu_items table (when dishes are added, edited, or deleted)
drop trigger if exists trg_menu_items_search_update on public.menu_items;
create trigger trg_menu_items_search_update
  after insert or update or delete
  on public.menu_items
  for each row
  execute function public.trigger_restaurant_data_changed();

