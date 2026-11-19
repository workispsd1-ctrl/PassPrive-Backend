-- Migration: Phase 2 (Production-Aligned) - Normalized Menu Items Table (menu_items)
-- Description:
--   1. Creates `public.menu_items` to store individual dishes parsed from `restaurants.menu_json`.
--   2. Supports all verified live dish properties: name, price, description, is_veg, is_bestseller, is_available, image_urls.
--   3. Adds course detection covering standard, Indian, and Mauritian/French menu sections (e.g. Gajak, Planche, Tapas, Entrée, Plats).
--   4. Provides an idempotent sync function and immediately backfills all existing live menus.

-- 1. CREATE menu_items TABLE
create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  original_item_id text, -- ID string/UUID from partner dashboard menu_json
  course text check (course in ('starter', 'main', 'dessert', 'drink', 'side')),
  section_id text,
  section text,
  subcategory_id text,
  subcategory text,
  name text not null,
  description text, -- sanitized, max 140 characters
  price numeric(10,2) not null default 0,
  variants jsonb not null default '[]'::jsonb, -- e.g. [{"name": "Half", "price": 250}, {"name": "Full", "price": 450}]
  is_veg boolean not null default false,
  diet_slugs text[] not null default '{}',
  is_bestseller boolean not null default false,
  is_signature boolean not null default false,
  is_available boolean not null default true,
  image_urls text[] not null default '{}',
  rank_score real not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure new columns exist if table was already created
alter table public.menu_items add column if not exists section_id text;
alter table public.menu_items add column if not exists subcategory_id text;
alter table public.menu_items add column if not exists subcategory text;
alter table public.menu_items add column if not exists variants jsonb not null default '[]'::jsonb;

-- 2. PERFORMANCE INDEXES
-- Index for candidate dish selection by course & rank score
create index if not exists idx_menu_items_top
  on public.menu_items (restaurant_id, course, rank_score desc)
  where is_available;

-- General restaurant foreign key index
create index if not exists idx_menu_items_restaurant_id
  on public.menu_items (restaurant_id);

-- Dietary filtering index (veg_friendly, vegan, jain, halal, gluten_free)
create index if not exists idx_menu_items_diet_slugs
  on public.menu_items using gin (diet_slugs);

-- Trigram index for fuzzy dish name queries (e.g. "surprise me with truffle risotto")
create index if not exists idx_menu_items_name_trgm
  on public.menu_items using gin (name gin_trgm_ops);

-- 3. ENHANCED HELPER FUNCTION TO DERIVE COURSE FROM SECTION & SUBCATEGORY NAME
-- Tailored to real production section/subcategory names (including Mauritian/Creole/French dining terms)
create or replace function public.derive_menu_course(section_name text, subcategory_name text default null)
returns text
language plpgsql
immutable
as $$
declare
  sub text := lower(coalesce(subcategory_name, ''));
  sec text := lower(coalesce(section_name, ''));
  combined text := trim(sub || ' ' || sec);
begin
  -- Check subcategory first when present (more specific than section)
  if sub <> '' then
    if sub ~* '(starter|appetizer|small plate|tapas|soup|salad|gajak|planche|entrée|entree|dim sum|chaat|bruschetta|mini croq|meze|mezze)' then
      return 'starter';
    elsif sub ~* '(dessert|sweet|ice cream|pastry|cake|halwa|gelato|sorbet|pancake|waffle|crepe|tiramisu)' then
      return 'dessert';
    elsif sub ~* '(drink|beverage|mocktail|cocktail|smoothie|coffee|tea|wine|beer|bar|juice|milkshake|soft|spirit|rum|gin|whisky)' then
      return 'drink';
    elsif sub ~* '(side|bread|naan|roti|rice|fries|dip|sauce|extra|accompaniment)' then
      return 'side';
    end if;
  end if;

  -- Fallback to section (and combined)
  if combined ~* '(starter|appetizer|small plate|tapas|soup|salad|gajak|planche|entrée|entree|dim sum|chaat|bruschetta|mini croq|meze|mezze)' then
    return 'starter';
  elsif combined ~* '(dessert|sweet|ice cream|pastry|cake|halwa|gelato|sorbet|pancake|waffle|crepe|tiramisu)' then
    return 'dessert';
  elsif combined ~* '(drink|beverage|mocktail|cocktail|smoothie|coffee|tea|wine|beer|bar|juice|milkshake|soft|spirit|rum|gin|whisky)' then
    return 'drink';
  elsif combined ~* '(side|bread|naan|roti|rice|fries|dip|sauce|extra|accompaniment)' then
    return 'side';
  else
    return 'main';
  end if;
end;
$$;

-- 4. FUNCTION TO SYNC/BACKFILL menu_json INTO menu_items FOR A GIVEN RESTAURANT
create or replace function public.sync_restaurant_menu_json_to_menu_items(target_restaurant_id uuid)
returns integer
language plpgsql
as $$
declare
  menu_blob jsonb;
  s record;
  i record;
  dish_count integer := 0;
  calculated_course text;
  calculated_rank real;
  diet_arr text[];
  resolved_subcat_id text;
  resolved_subcat_name text;
  item_variants jsonb;
begin
  -- Fetch the restaurant's menu_json
  select menu_json into menu_blob
  from public.restaurants
  where id = target_restaurant_id;

  if menu_blob is null or not (jsonb_typeof(menu_blob->'sections') = 'array') then
    return 0;
  end if;

  -- Delete existing menu_items for clean replacement
  delete from public.menu_items where restaurant_id = target_restaurant_id;

  -- Loop through sections
  for s in select * from jsonb_array_elements(menu_blob->'sections') as sec loop
    -- Loop through items in each section
    for i in select * from jsonb_array_elements(case when jsonb_typeof(s.sec->'items') = 'array' then s.sec->'items' else '[]'::jsonb end) as itm loop
      -- Resolve subcategory name if item references section.subcategories[].id
      resolved_subcat_id := nullif(trim(i.itm->>'subcategory_id'), '');
      resolved_subcat_name := null;
      if resolved_subcat_id is not null and jsonb_typeof(s.sec->'subcategories') = 'array' then
        select nullif(trim(sub->>'name'), '') into resolved_subcat_name
        from jsonb_array_elements(s.sec->'subcategories') as sub
        where sub->>'id' = resolved_subcat_id
        limit 1;
      end if;

      calculated_course := public.derive_menu_course(s.sec->>'name', resolved_subcat_name);

      -- Compute initial rank score (bestsellers get boosted)
      calculated_rank := 0;
      if coalesce((i.itm->>'is_bestseller')::boolean, false) then
        calculated_rank := calculated_rank + 2.0;
      end if;

      diet_arr := '{}';
      if coalesce((i.itm->>'is_veg')::boolean, false) then
        diet_arr := array_append(diet_arr, 'veg_friendly');
      end if;

      item_variants := case
        when jsonb_typeof(i.itm->'variants') = 'array' then i.itm->'variants'
        else '[]'::jsonb
      end;

      insert into public.menu_items (
        restaurant_id,
        original_item_id,
        course,
        section_id,
        section,
        subcategory_id,
        subcategory,
        name,
        description,
        price,
        variants,
        is_veg,
        diet_slugs,
        is_bestseller,
        is_signature,
        is_available,
        image_urls,
        rank_score
      ) values (
        target_restaurant_id,
        i.itm->>'id',
        calculated_course,
        nullif(trim(s.sec->>'id'), ''),
        nullif(trim(s.sec->>'name'), ''),
        resolved_subcat_id,
        resolved_subcat_name,
        coalesce(nullif(trim(i.itm->>'name'), ''), 'Item'),
        left(nullif(trim(i.itm->>'description'), ''), 140),
        coalesce((i.itm->>'price')::numeric, 0),
        item_variants,
        coalesce((i.itm->>'is_veg')::boolean, false),
        diet_arr,
        coalesce((i.itm->>'is_bestseller')::boolean, false),
        false,
        coalesce((i.itm->>'is_available')::boolean, true),
        case
          when jsonb_typeof(i.itm->'image_urls') = 'array' then
            array(select jsonb_array_elements_text(i.itm->'image_urls'))
          when i.itm->>'image_url' is not null then
            array[i.itm->>'image_url']
          else
            '{}'::text[]
        end,
        calculated_rank
      );

      dish_count := dish_count + 1;
    end loop;
  end loop;

  return dish_count;
end;
$$;

-- 5. INITIAL ONE-TIME BACKFILL: Unpack all existing restaurants that have menu_json
do $$
declare
  rec record;
begin
  for rec in select id from public.restaurants where menu_json is not null loop
    perform public.sync_restaurant_menu_json_to_menu_items(rec.id);
  end loop;
end $$;
