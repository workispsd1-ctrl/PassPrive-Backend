-- Add external POS columns to restaurant_bookings table to track synced bookings
ALTER TABLE public.restaurant_bookings
ADD COLUMN IF NOT EXISTS external_pos_id text NULL,
ADD COLUMN IF NOT EXISTS external_pos_reference text NULL;

-- Create indexes on external POS columns for reconciliation
CREATE INDEX IF NOT EXISTS restaurant_bookings_external_pos_id_idx ON public.restaurant_bookings (external_pos_id);
