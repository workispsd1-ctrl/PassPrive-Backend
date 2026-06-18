ALTER TABLE public.tourist_places
  ADD COLUMN IF NOT EXISTS price_child NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS price_local_adult NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS price_local_child NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS child_age_min INTEGER NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS child_age_max INTEGER NULL;

-- Price constraints
ALTER TABLE public.tourist_places DROP CONSTRAINT IF EXISTS tourist_places_price_child_chk;
ALTER TABLE public.tourist_places ADD CONSTRAINT tourist_places_price_child_chk CHECK (price_child IS NULL OR price_child >= 0.00);

ALTER TABLE public.tourist_places DROP CONSTRAINT IF EXISTS tourist_places_price_local_adult_chk;
ALTER TABLE public.tourist_places ADD CONSTRAINT tourist_places_price_local_adult_chk CHECK (price_local_adult IS NULL OR price_local_adult >= 0.00);

ALTER TABLE public.tourist_places DROP CONSTRAINT IF EXISTS tourist_places_price_local_child_chk;
ALTER TABLE public.tourist_places ADD CONSTRAINT tourist_places_price_local_child_chk CHECK (price_local_child IS NULL OR price_local_child >= 0.00);

-- Age constraint
ALTER TABLE public.tourist_places DROP CONSTRAINT IF EXISTS tourist_places_child_age_range_chk;
ALTER TABLE public.tourist_places ADD CONSTRAINT tourist_places_child_age_range_chk CHECK (
  (child_age_min IS NULL AND child_age_max IS NULL) OR
  (child_age_min IS NOT NULL AND child_age_max IS NOT NULL AND child_age_min <= child_age_max)
);
