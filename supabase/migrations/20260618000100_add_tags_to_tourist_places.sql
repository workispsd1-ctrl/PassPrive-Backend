-- Add tags array column to tourist_places
ALTER TABLE public.tourist_places 
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'::text[];

-- Create GIN index for efficient tag querying
CREATE INDEX IF NOT EXISTS tourist_places_tags_gin_idx 
  ON public.tourist_places USING gin (tags);
