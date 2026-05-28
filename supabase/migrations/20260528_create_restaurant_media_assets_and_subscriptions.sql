-- Create restaurant_media_assets table
CREATE TABLE IF NOT EXISTS restaurant_media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_path TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_restaurant_media_assets_restaurant_id
  ON restaurant_media_assets(restaurant_id);

-- Create restaurant_subscriptions table
CREATE TABLE IF NOT EXISTS restaurant_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  unlock_all BOOLEAN NOT NULL DEFAULT FALSE,
  time_slot_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  repeat_rewards_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  dish_discounts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_restaurant_subscriptions_restaurant_id
  ON restaurant_subscriptions(restaurant_id);
