CREATE TABLE IF NOT EXISTS public.tourist_place_activities (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tourist_place_id UUID NOT NULL,
  activity_type TEXT NOT NULL,
  price_adult NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  price_child NUMERIC(10, 2) NULL,
  child_age_min INTEGER NULL DEFAULT 0,
  child_age_max INTEGER NULL,
  child_special_offer TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

  CONSTRAINT tourist_place_activities_pkey PRIMARY KEY (id),
  CONSTRAINT tourist_place_activities_tourist_place_id_fkey FOREIGN KEY (tourist_place_id) REFERENCES public.tourist_places (id) ON DELETE CASCADE,
  CONSTRAINT tourist_place_activities_activity_type_chk CHECK (
    activity_type = ANY (ARRAY[
      'zipline'::text,
      'quad_biking_single'::text,
      'quad_biking_double'::text,
      'horseback_riding'::text,
      'guided_hiking'::text,
      'safari'::text,
      'karting'::text,
      'nepalese_bridge'::text,
      'aviary'::text,
      'petting_feeding'::text
    ])
  ),
  CONSTRAINT tourist_place_activities_price_adult_chk CHECK (price_adult >= 0.00),
  CONSTRAINT tourist_place_activities_price_child_chk CHECK (price_child IS NULL OR price_child >= 0.00),
  CONSTRAINT tourist_place_activities_child_age_range_chk CHECK (
    (child_age_min IS NULL AND child_age_max IS NULL) OR
    (child_age_min IS NOT NULL AND child_age_max IS NOT NULL AND child_age_min <= child_age_max)
  )
) TABLESPACE pg_default;

-- Unique constraint so each place can only have one configuration per activity type
CREATE UNIQUE INDEX IF NOT EXISTS tourist_place_activities_unique_type_idx ON public.tourist_place_activities (tourist_place_id, activity_type);
CREATE INDEX IF NOT EXISTS tourist_place_activities_place_id_idx ON public.tourist_place_activities USING btree (tourist_place_id);

-- Set updated_at trigger
DROP TRIGGER IF EXISTS trg_tourist_place_activities_set_updated_at ON public.tourist_place_activities;
CREATE TRIGGER trg_tourist_place_activities_set_updated_at BEFORE UPDATE ON public.tourist_place_activities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Enable Row Level Security (RLS)
ALTER TABLE public.tourist_place_activities ENABLE ROW LEVEL SECURITY;

-- Select policies
DROP POLICY IF EXISTS "tourist_place_activities_select_public" ON public.tourist_place_activities;
CREATE POLICY "tourist_place_activities_select_public" ON public.tourist_place_activities
  FOR SELECT TO anon, authenticated USING (is_active = true OR public.is_app_admin());

-- Admin write policies
DROP POLICY IF EXISTS "tourist_place_activities_admin_all" ON public.tourist_place_activities;
CREATE POLICY "tourist_place_activities_admin_all" ON public.tourist_place_activities
  FOR ALL TO authenticated USING (public.is_app_admin()) WITH CHECK (public.is_app_admin());
