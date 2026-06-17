-- 1. Alter payment_option column type to array with type conversion
ALTER TABLE public.tourist_places 
  DROP CONSTRAINT IF EXISTS tourist_places_payment_option_chk;

ALTER TABLE public.tourist_places 
  ALTER COLUMN payment_option TYPE TEXT[] USING ARRAY[payment_option];

ALTER TABLE public.tourist_places 
  ALTER COLUMN payment_option SET DEFAULT ARRAY['free'::text];

ALTER TABLE public.tourist_places 
  ADD CONSTRAINT tourist_places_payment_option_chk CHECK (
    payment_option <@ ARRAY['free'::text, 'ips'::text, 'card'::text, 'mopay'::text, 'mopay_place'::text]
  );

-- 2. Define Storage RLS Policies for tourist-images bucket
-- Check if bucket policy already exists to prevent duplicate key errors
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'Public Read Access'
  ) THEN
    CREATE POLICY "Public Read Access" 
      ON storage.objects FOR SELECT 
      USING (bucket_id = 'tourist-images');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'Admin Insert Files'
  ) THEN
    CREATE POLICY "Admin Insert Files" 
      ON storage.objects FOR INSERT 
      TO authenticated 
      WITH CHECK (bucket_id = 'tourist-images' AND public.is_app_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'Admin Update Delete Files'
  ) THEN
    CREATE POLICY "Admin Update Delete Files" 
      ON storage.objects FOR ALL 
      TO authenticated 
      USING (bucket_id = 'tourist-images' AND public.is_app_admin());
  END IF;
END $$;
