-- Migration: Phase 1 (Production-Verified) - Extensions, Unified Tags & Existing Tag Alignment
-- Description:
--   1. Enables required PostgreSQL extensions: pg_trgm (fuzzy search), postgis (geography/distance), vector (pgvector 1536 embeddings).
--   2. Creates `public.tags` catalog and auto-populates it from REAL production tables:
--      - Moods: loaded directly from live `restaurant_mood_categories`
--      - Cuisines: loaded directly from distinct `restaurant_tags WHERE tag_type = 'cuisine'`
--      - Ambience / Facilities: loaded directly from distinct `restaurant_tags WHERE tag_type = 'facility'`
--      - Dietary: pre-seeds standard verified dietary filters (veg_friendly, vegan, jain, halal, gluten_free)
--   3. Safely augments existing `restaurant_tags` with `is_primary` and `tag_id` without modifying or deleting any of the 22,000+ existing records.
--   4. Links existing `restaurant_tags` rows to their corresponding `tags.id`.

-- 1. EXTENSIONS
create extension if not exists pg_trgm;
create extension if not exists postgis;
create extension if not exists vector;

-- 2. TAG TYPE ENUM
do $$
begin
  if not exists (select 1 from pg_type where typname = 'tag_type') then
    create type tag_type as enum (
      'mood',
      'occasion',
      'best_for',
      'ambience',
      'dietary',
      'cuisine',
      'price_band',
      'feature'
    );
  end if;
end $$;

-- 3. UNIFIED CONTROLLED TAGS CATALOG TABLE
create table if not exists public.tags (
  id smallint generated always as identity primary key,
  type tag_type not null,
  slug text not null,
  label text not null,
  created_at timestamptz not null default now(),
  constraint uq_tags_type_slug unique (type, slug)
);

create index if not exists idx_tags_type_slug on public.tags (type, slug);

-- 4. SAFELY AUGMENT EXISTING restaurant_tags TABLE
alter table public.restaurant_tags
  add column if not exists is_primary boolean not null default false,
  add column if not exists tag_id smallint references public.tags(id) on delete set null;

create index if not exists idx_restaurant_tags_primary
  on public.restaurant_tags (restaurant_id, is_primary);

create index if not exists idx_restaurant_tags_tag_id
  on public.restaurant_tags (tag_id);

-- 5. POPULATE TAGS DIRECTLY FROM REAL PRODUCTION DATA

-- A. Live Moods from restaurant_mood_categories
insert into public.tags (type, slug, label)
select
  'mood'::tag_type,
  replace(lower(trim(slug)), '-', '_'),
  trim(title)
from public.restaurant_mood_categories
where is_active = true and nullif(trim(slug), '') is not null
on conflict (type, slug) do update set label = excluded.label;

-- B. Live Cuisines from existing restaurant_tags
insert into public.tags (type, slug, label)
select distinct
  'cuisine'::tag_type,
  lower(regexp_replace(regexp_replace(trim(tag_value), '[^a-zA-Z0-9]+', '_', 'g'), '(^_|_$)', '', 'g')),
  trim(tag_value)
from public.restaurant_tags
where tag_type = 'cuisine'
  and nullif(trim(tag_value), '') is not null
  and length(trim(tag_value)) <= 60
on conflict (type, slug) do update set label = excluded.label;

-- C. Live Ambience & Facilities from existing restaurant_tags
insert into public.tags (type, slug, label)
select distinct
  'ambience'::tag_type,
  lower(regexp_replace(regexp_replace(trim(tag_value), '[^a-zA-Z0-9]+', '_', 'g'), '(^_|_$)', '', 'g')),
  trim(tag_value)
from public.restaurant_tags
where tag_type = 'facility'
  and nullif(trim(tag_value), '') is not null
  and length(trim(tag_value)) <= 60
on conflict (type, slug) do update set label = excluded.label;

-- D. Standard Dietary Requirements (Hard filters)
insert into public.tags (type, slug, label)
values
  ('dietary', 'veg_friendly', 'Vegetarian Friendly'),
  ('dietary', 'vegan', 'Vegan'),
  ('dietary', 'jain', 'Jain Friendly'),
  ('dietary', 'halal', 'Halal'),
  ('dietary', 'gluten_free', 'Gluten Free')
on conflict (type, slug) do update set label = excluded.label;

-- E. Occasions & Common Best-For Enums
insert into public.tags (type, slug, label)
values
  ('occasion', 'date_night', 'Date Night'),
  ('occasion', 'birthday', 'Birthday'),
  ('occasion', 'anniversary', 'Anniversary'),
  ('occasion', 'business_meal', 'Business Meal'),
  ('occasion', 'friends_catchup', 'Friends Catchup'),
  ('occasion', 'family_meal', 'Family Meal'),
  ('best_for', 'families', 'Families'),
  ('best_for', 'groups', 'Groups'),
  ('best_for', 'solo', 'Solo Dining'),
  ('best_for', 'kids', 'Kids')
on conflict (type, slug) do update set label = excluded.label;

-- 6. LINK EXISTING restaurant_tags ROWS TO NEW tags.id
-- Match by label or normalized slug for moods, cuisines, and facilities
update public.restaurant_tags rt
set tag_id = t.id
from public.tags t
where rt.tag_id is null
  and (
    lower(trim(rt.tag_value)) = lower(trim(t.label))
    or lower(regexp_replace(regexp_replace(trim(rt.tag_value), '[^a-zA-Z0-9]+', '_', 'g'), '(^_|_$)', '', 'g')) = t.slug
  );
