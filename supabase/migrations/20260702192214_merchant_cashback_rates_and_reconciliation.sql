-- Preferred merchant commercial config (mdr_rate already exists = CIM MDR).
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS merchant_total_rate REAL,   -- all-inclusive % PassPrive charges the merchant
  ADD COLUMN IF NOT EXISTS merchant_reward_rate REAL;  -- merchant-funded cashback % credited to the customer

-- Per-transaction snapshot for CIM MDR invoicing reconciliation.
ALTER TABLE public.bill_payments
  ADD COLUMN IF NOT EXISTS mdr_rate REAL,
  ADD COLUMN IF NOT EXISTS merchant_total_rate REAL,
  ADD COLUMN IF NOT EXISTS merchant_reward_rate REAL;
