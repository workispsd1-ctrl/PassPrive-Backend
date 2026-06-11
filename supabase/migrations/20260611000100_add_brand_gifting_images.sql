-- Add brand gifting logo and card image columns to stores
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS gifting_logo_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS gifting_logo_path TEXT NULL,
  ADD COLUMN IF NOT EXISTS gifting_card_image_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS gifting_card_image_path TEXT NULL;

-- Add brand gifting logo and card image columns to restaurants
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS gifting_logo_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS gifting_logo_path TEXT NULL,
  ADD COLUMN IF NOT EXISTS gifting_card_image_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS gifting_card_image_path TEXT NULL;

-- Create storage bucket for brand gifting assets if it doesn't exist
INSERT INTO storage.buckets (id, name, public) 
VALUES ('brand-gifting-assets', 'brand-gifting-assets', true)
ON CONFLICT (id) DO NOTHING;
