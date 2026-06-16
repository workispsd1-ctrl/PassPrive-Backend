-- Create tourist_places table
CREATE TABLE IF NOT EXISTS public.tourist_places (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  place_name TEXT NOT NULL,
  phone TEXT NULL,
  area TEXT NULL,
  city TEXT NULL,
  full_address TEXT NULL,
  location_name TEXT NULL, -- Frontend support
  slug TEXT NULL,
  cover_image TEXT NULL,
  picture_id TEXT NULL,    -- Frontend support (points to cover image in bucket)
  latitude NUMERIC(9, 6) NULL,
  longitude NUMERIC(9, 6) NULL,
  description TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  owner_user_id UUID NULL,
  booking_enabled BOOLEAN NOT NULL DEFAULT true,
  advance_booking_days INTEGER NOT NULL DEFAULT 30,
  modification_available BOOLEAN NOT NULL DEFAULT false,
  modification_cutoff_minutes INTEGER NULL,
  cancellation_available BOOLEAN NOT NULL DEFAULT false,
  cancellation_cutoff_minutes INTEGER NULL,
  payment_option TEXT NOT NULL DEFAULT 'free'::text,
  price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  rating NUMERIC(3, 2) NOT NULL DEFAULT 5.00,
  reviews_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  is_advertised BOOLEAN NOT NULL DEFAULT false,
  ad_priority INTEGER NULL,
  ad_starts_at TIMESTAMP WITH TIME ZONE NULL,
  ad_ends_at TIMESTAMP WITH TIME ZONE NULL,
  ad_badge_text TEXT NULL,
  booking_terms TEXT[] NOT NULL DEFAULT '{}'::text[],
  google_place_id TEXT NULL,
  source TEXT NULL DEFAULT 'google'::text,
  source_payload JSONB NULL,
  last_synced_at TIMESTAMP WITHOUT TIME ZONE NULL,
  user_ratings_total INTEGER NULL,
  place_types TEXT[] NULL,
  country TEXT NULL DEFAULT 'Mauritius'::text,

  CONSTRAINT tourist_places_pkey PRIMARY KEY (id),
  CONSTRAINT tourist_places_slug_key UNIQUE (slug),
  CONSTRAINT tourist_places_google_place_id_key UNIQUE (google_place_id),
  CONSTRAINT tourist_places_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT tourist_places_payment_option_chk CHECK (
    payment_option = ANY (ARRAY['free'::text, 'paid_online'::text, 'paid_on_arrival'::text])
  ),
  CONSTRAINT tourist_places_price_chk CHECK (price >= 0.00),
  CONSTRAINT tourist_places_rating_chk CHECK (rating >= 0.00 AND rating <= 5.00),
  CONSTRAINT tourist_places_reviews_count_chk CHECK (reviews_count >= 0),
  CONSTRAINT tourist_places_cancellation_cutoff_chk CHECK (
    (cancellation_available = true) OR (cancellation_cutoff_minutes IS NULL)
  ),
  CONSTRAINT tourist_places_modification_cutoff_chk CHECK (
    (modification_available = true) OR (modification_cutoff_minutes IS NULL)
  ),
  CONSTRAINT tourist_places_ad_consistency_chk CHECK (
    (is_advertised = false) OR ((is_advertised = true) AND (ad_priority IS NOT NULL))
  ),
  CONSTRAINT tourist_places_ad_priority_chk CHECK (
    (ad_priority IS NULL) OR (ad_priority >= 0)
  ),
  CONSTRAINT tourist_places_advance_booking_days_chk CHECK (advance_booking_days >= 0),
  CONSTRAINT tourist_places_ad_time_range_chk CHECK (
    (ad_starts_at IS NULL) OR (ad_ends_at IS NULL) OR (ad_starts_at <= ad_ends_at)
  ),
  CONSTRAINT tourist_places_latitude_chk CHECK (
    (latitude IS NULL) OR ((latitude >= -90.0) AND (latitude <= 90.0))
  ),
  CONSTRAINT tourist_places_longitude_chk CHECK (
    (longitude IS NULL) OR ((longitude >= -180.0) AND (longitude <= 180.0))
  )
) TABLESPACE pg_default;

-- Create tourist_place_reviews table
CREATE TABLE IF NOT EXISTS public.tourist_place_reviews (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tourist_place_id UUID NOT NULL,
  user_id UUID NULL,
  rating NUMERIC(2, 1) NOT NULL,
  review_text TEXT NULL,
  liked_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  photo_urls TEXT[] NOT NULL DEFAULT '{}'::text[],
  username_snapshot TEXT NULL,
  avatar_snapshot TEXT NULL,
  is_approved BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  guide_rating NUMERIC(2, 1) NULL,
  safety_rating NUMERIC(2, 1) NULL,
  cleanliness_rating NUMERIC(2, 1) NULL,
  value_rating NUMERIC(2, 1) NULL,
  crowd_rating NUMERIC(2, 1) NULL,
  owner_reply_text TEXT NULL,
  owner_reply_by UUID NULL,
  owner_reply_at TIMESTAMP WITH TIME ZONE NULL,
  owner_reply_updated_at TIMESTAMP WITH TIME ZONE NULL,
  source TEXT NULL DEFAULT 'internal'::text,
  external_review_id TEXT NULL,

  CONSTRAINT tourist_place_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT tourist_place_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
  CONSTRAINT tourist_place_reviews_owner_reply_by_fkey FOREIGN KEY (owner_reply_by) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT tourist_place_reviews_tourist_place_id_fkey FOREIGN KEY (tourist_place_id) REFERENCES public.tourist_places (id) ON DELETE CASCADE,
  CONSTRAINT tourist_place_reviews_rating_chk CHECK (
    (rating >= 0.0) AND (rating <= 5.0)
  ),
  CONSTRAINT tourist_place_reviews_guide_rating_chk CHECK (
    (guide_rating IS NULL) OR ((guide_rating >= 0.0) AND (guide_rating <= 5.0))
  ),
  CONSTRAINT tourist_place_reviews_safety_rating_chk CHECK (
    (safety_rating IS NULL) OR ((safety_rating >= 0.0) AND (safety_rating <= 5.0))
  ),
  CONSTRAINT tourist_place_reviews_cleanliness_rating_chk CHECK (
    (cleanliness_rating IS NULL) OR ((cleanliness_rating >= 0.0) AND (cleanliness_rating <= 5.0))
  ),
  CONSTRAINT tourist_place_reviews_value_rating_chk CHECK (
    (value_rating IS NULL) OR ((value_rating >= 0.0) AND (value_rating <= 5.0))
  ),
  CONSTRAINT tourist_place_reviews_crowd_rating_chk CHECK (
    (crowd_rating IS NULL) OR ((crowd_rating >= 0.0) AND (crowd_rating <= 5.0))
  )
) TABLESPACE pg_default;

-- Create tourist_place_opening_hours table
CREATE TABLE IF NOT EXISTS public.tourist_place_opening_hours (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tourist_place_id UUID NOT NULL,
  day_of_week INTEGER NOT NULL,
  open_time TIME WITHOUT TIME ZONE NULL,
  close_time TIME WITHOUT TIME ZONE NULL,
  is_closed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

  CONSTRAINT tourist_place_opening_hours_pkey PRIMARY KEY (id),
  CONSTRAINT tourist_place_opening_hours_tourist_place_id_fkey FOREIGN KEY (tourist_place_id) REFERENCES public.tourist_places (id) ON DELETE CASCADE,
  CONSTRAINT tourist_place_opening_hours_day_of_week_chk CHECK (
    (day_of_week >= 0) AND (day_of_week <= 6)
  ),
  CONSTRAINT tourist_place_opening_hours_time_order_chk CHECK (
    (is_closed = true) OR (open_time <> close_time)
  ),
  CONSTRAINT tourist_place_opening_hours_time_required_chk CHECK (
    (
      (is_closed = true AND open_time IS NULL AND close_time IS NULL)
      OR
      (is_closed = false AND open_time IS NOT NULL AND close_time IS NOT NULL)
    )
  )
) TABLESPACE pg_default;

-- Create tourist_place_media_assets table
CREATE TABLE IF NOT EXISTS public.tourist_place_media_assets (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tourist_place_id UUID NOT NULL,
  asset_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_path TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  google_photo_reference TEXT NULL,
  local_file_path TEXT NULL,
  mime_type TEXT NULL,
  storage_bucket TEXT NULL,
  storage_path TEXT NULL,
  storage_public_url TEXT NULL,
  enhanced_file_url TEXT NULL,
  enhanced_storage_path TEXT NULL,
  enhanced_storage_public_url TEXT NULL,

  CONSTRAINT tourist_place_media_assets_pkey PRIMARY KEY (id),
  CONSTRAINT tourist_place_media_assets_tourist_place_id_fkey FOREIGN KEY (tourist_place_id) REFERENCES public.tourist_places (id) ON DELETE CASCADE,
  CONSTRAINT tourist_place_media_assets_asset_type_chk CHECK (
    (asset_type = ANY (ARRAY['food'::text, 'ambience'::text, 'menu'::text, 'cover'::text, 'scenery'::text, 'activity'::text]))
  ),
  CONSTRAINT tourist_place_media_assets_file_url_chk CHECK (
    (length(TRIM(BOTH FROM file_url)) > 0)
  ),
  CONSTRAINT tourist_place_media_assets_sort_order_chk CHECK (sort_order >= 0)
) TABLESPACE pg_default;

-- Indexes setup
CREATE INDEX IF NOT EXISTS tourist_places_active_city_area_idx ON public.tourist_places USING btree (is_active, city, area) TABLESPACE pg_default;
CREATE INDEX IF NOT EXISTS tourist_places_owner_user_id_idx ON public.tourist_places USING btree (owner_user_id) TABLESPACE pg_default;
CREATE INDEX IF NOT EXISTS tourist_places_location_idx ON public.tourist_places USING btree (latitude, longitude) TABLESPACE pg_default;
CREATE INDEX IF NOT EXISTS tourist_places_advertised_idx ON public.tourist_places USING btree (is_advertised, ad_priority, ad_starts_at, ad_ends_at) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS tourist_place_reviews_tourist_place_id_idx ON public.tourist_place_reviews USING btree (tourist_place_id) TABLESPACE pg_default;
CREATE INDEX IF NOT EXISTS tourist_place_reviews_user_id_idx ON public.tourist_place_reviews USING btree (user_id) TABLESPACE pg_default;
CREATE INDEX IF NOT EXISTS tourist_place_reviews_created_at_idx ON public.tourist_place_reviews USING btree (created_at DESC) TABLESPACE pg_default;
CREATE INDEX IF NOT EXISTS tourist_place_reviews_liked_tags_gin_idx ON public.tourist_place_reviews USING gin (liked_tags) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS tourist_place_opening_hours_tourist_place_id_idx ON public.tourist_place_opening_hours USING btree (tourist_place_id) TABLESPACE pg_default;
CREATE INDEX IF NOT EXISTS tourist_place_opening_hours_day_idx ON public.tourist_place_opening_hours USING btree (tourist_place_id, day_of_week) TABLESPACE pg_default;
CREATE UNIQUE INDEX IF NOT EXISTS tourist_place_opening_hours_unique_idx ON public.tourist_place_opening_hours USING btree (tourist_place_id, day_of_week) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS tourist_place_media_assets_tourist_place_id_idx ON public.tourist_place_media_assets USING btree (tourist_place_id) TABLESPACE pg_default;
CREATE INDEX IF NOT EXISTS tourist_place_media_assets_asset_type_idx ON public.tourist_place_media_assets USING btree (asset_type) TABLESPACE pg_default;
CREATE INDEX IF NOT EXISTS tourist_place_media_assets_active_sort_idx ON public.tourist_place_media_assets USING btree (tourist_place_id, is_active, sort_order, created_at) TABLESPACE pg_default;
CREATE UNIQUE INDEX IF NOT EXISTS tourist_place_media_assets_one_cover_idx ON public.tourist_place_media_assets USING btree (tourist_place_id) TABLESPACE pg_default WHERE ((asset_type = 'cover'::text) AND (is_active = true));

-- Triggers for automatic updated_at updates
DROP TRIGGER IF EXISTS trg_tourist_places_set_updated_at ON public.tourist_places;
CREATE TRIGGER trg_tourist_places_set_updated_at BEFORE UPDATE ON public.tourist_places FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_tourist_place_reviews_set_updated_at ON public.tourist_place_reviews;
CREATE TRIGGER trg_tourist_place_reviews_set_updated_at BEFORE UPDATE ON public.tourist_place_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_tourist_place_opening_hours_set_updated_at ON public.tourist_place_opening_hours;
CREATE TRIGGER trg_tourist_place_opening_hours_set_updated_at BEFORE UPDATE ON public.tourist_place_opening_hours FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_tourist_place_media_assets_set_updated_at ON public.tourist_place_media_assets;
CREATE TRIGGER trg_tourist_place_media_assets_set_updated_at BEFORE UPDATE ON public.tourist_place_media_assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Enable Row Level Security (RLS)
ALTER TABLE public.tourist_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tourist_place_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tourist_place_opening_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tourist_place_media_assets ENABLE ROW LEVEL SECURITY;

-- 1. Policies for tourist_places
DROP POLICY IF EXISTS "tourist_places_select_public" ON public.tourist_places;
CREATE POLICY "tourist_places_select_public" ON public.tourist_places
  FOR SELECT TO anon, authenticated USING (is_active = true OR public.is_app_admin());

DROP POLICY IF EXISTS "tourist_places_admin_all" ON public.tourist_places;
CREATE POLICY "tourist_places_admin_all" ON public.tourist_places
  FOR ALL TO authenticated USING (public.is_app_admin()) WITH CHECK (public.is_app_admin());

-- 2. Policies for tourist_place_reviews
DROP POLICY IF EXISTS "tourist_place_reviews_select_approved" ON public.tourist_place_reviews;
CREATE POLICY "tourist_place_reviews_select_approved" ON public.tourist_place_reviews
  FOR SELECT TO anon, authenticated USING (is_approved = true OR public.is_app_admin());

DROP POLICY IF EXISTS "tourist_place_reviews_insert_own" ON public.tourist_place_reviews;
CREATE POLICY "tourist_place_reviews_insert_own" ON public.tourist_place_reviews
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "tourist_place_reviews_update_own" ON public.tourist_place_reviews;
CREATE POLICY "tourist_place_reviews_update_own" ON public.tourist_place_reviews
  FOR UPDATE TO authenticated USING (auth.uid() = user_id OR public.is_app_admin()) WITH CHECK (auth.uid() = user_id OR public.is_app_admin());

DROP POLICY IF EXISTS "tourist_place_reviews_delete_own_or_admin" ON public.tourist_place_reviews;
CREATE POLICY "tourist_place_reviews_delete_own_or_admin" ON public.tourist_place_reviews
  FOR DELETE TO authenticated USING (auth.uid() = user_id OR public.is_app_admin());

-- 3. Policies for tourist_place_opening_hours
DROP POLICY IF EXISTS "tourist_place_opening_hours_select_all" ON public.tourist_place_opening_hours;
CREATE POLICY "tourist_place_opening_hours_select_all" ON public.tourist_place_opening_hours
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "tourist_place_opening_hours_admin_all" ON public.tourist_place_opening_hours;
CREATE POLICY "tourist_place_opening_hours_admin_all" ON public.tourist_place_opening_hours
  FOR ALL TO authenticated USING (public.is_app_admin()) WITH CHECK (public.is_app_admin());

-- 4. Policies for tourist_place_media_assets
DROP POLICY IF EXISTS "tourist_place_media_assets_select_active" ON public.tourist_place_media_assets;
CREATE POLICY "tourist_place_media_assets_select_active" ON public.tourist_place_media_assets
  FOR SELECT TO anon, authenticated USING (is_active = true OR public.is_app_admin());

DROP POLICY IF EXISTS "tourist_place_media_assets_admin_all" ON public.tourist_place_media_assets;
CREATE POLICY "tourist_place_media_assets_admin_all" ON public.tourist_place_media_assets
  FOR ALL TO authenticated USING (public.is_app_admin()) WITH CHECK (public.is_app_admin());

-- Storage bucket creation
INSERT INTO storage.buckets (id, name, public) 
VALUES ('tourist-images', 'tourist-images', true)
ON CONFLICT (id) DO NOTHING;
