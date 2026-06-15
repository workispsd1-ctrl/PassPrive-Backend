-- Add brand configuration columns to stores
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS gifting_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gifting_discount_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS gifting_start_date TIMESTAMP WITH TIME ZONE NULL,
  ADD COLUMN IF NOT EXISTS gifting_end_date TIMESTAMP WITH TIME ZONE NULL;

-- Add brand configuration columns to restaurants
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS gifting_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gifting_discount_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS gifting_start_date TIMESTAMP WITH TIME ZONE NULL,
  ADD COLUMN IF NOT EXISTS gifting_end_date TIMESTAMP WITH TIME ZONE NULL;

-- Add optional references to gift_codes
ALTER TABLE public.gift_codes
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES public.stores(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES public.restaurants(id) ON DELETE SET NULL;

-- Add optional references to gift_transactions
ALTER TABLE public.gift_transactions
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES public.stores(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES public.restaurants(id) ON DELETE SET NULL;

-- Create brand_gift_balances table
CREATE TABLE IF NOT EXISTS public.brand_gift_balances (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  store_id UUID NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  restaurant_id UUID NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  CONSTRAINT brand_gift_balances_pkey PRIMARY KEY (id),
  CONSTRAINT brand_gift_balances_brand_check CHECK (
    (store_id IS NOT NULL AND restaurant_id IS NULL) OR 
    (store_id IS NULL AND restaurant_id IS NOT NULL)
  ),
  CONSTRAINT brand_gift_balances_balance_chk CHECK (balance >= 0.00)
) TABLESPACE pg_default;

-- Create unique indexes to allow ON CONFLICT target mapping
CREATE UNIQUE INDEX IF NOT EXISTS brand_gift_balances_store_idx ON public.brand_gift_balances (user_id, store_id) WHERE store_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS brand_gift_balances_restaurant_idx ON public.brand_gift_balances (user_id, restaurant_id) WHERE restaurant_id IS NOT NULL;

-- Create trigger for set_updated_at on brand_gift_balances
CREATE TRIGGER trg_brand_gift_balances_set_updated_at BEFORE UPDATE ON brand_gift_balances FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Relax entity scope checks on payment_sessions to support store_id and restaurant_id for GIFT_PURCHASE context
ALTER TABLE public.payment_sessions
  DROP CONSTRAINT IF EXISTS payment_sessions_entity_scope_chk;

ALTER TABLE public.payment_sessions
  ADD CONSTRAINT payment_sessions_entity_scope_chk CHECK (
    (
      (payment_context = 'BOOKING'::text)
      AND (restaurant_id IS NOT NULL)
      AND (store_id IS NULL)
    )
    OR (
      (payment_context = 'BILL_PAYMENT'::text)
      AND (
        (
          (restaurant_id IS NOT NULL)
          AND (store_id IS NULL)
        )
        OR (
          (restaurant_id IS NULL)
          AND (store_id IS NOT NULL)
        )
      )
    )
    OR (
      (payment_context = 'MEMBERSHIP'::text)
      AND (restaurant_id IS NULL)
      AND (store_id IS NULL)
    )
    OR (
      (payment_context = 'TABLE_ORDERS'::text)
      AND (restaurant_id IS NOT NULL)
      AND (store_id IS NULL)
    )
    OR (
      (payment_context = 'GIFT_PURCHASE'::text)
      AND (
        (restaurant_id IS NULL AND store_id IS NULL)
        OR (restaurant_id IS NOT NULL AND store_id IS NULL)
        OR (restaurant_id IS NULL AND store_id IS NOT NULL)
      )
    )
  );

-- Redefine RPC function to redeem gift codes atomically, keeping brand restrictions in place
CREATE OR REPLACE FUNCTION public.redeem_gift_code(p_code text, p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_gift_id uuid;
  v_amount numeric(10, 2);
  v_status text;
  v_new_balance numeric(10, 2);
  v_store_id uuid;
  v_restaurant_id uuid;
BEGIN
  -- Select and lock the gift code row to prevent concurrent redemptions
  SELECT id, amount, status, store_id, restaurant_id INTO v_gift_id, v_amount, v_status, v_store_id, v_restaurant_id
  FROM public.gift_codes
  WHERE code = p_code
  FOR UPDATE;

  -- Verify existence and status
  IF v_gift_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Gift code not found');
  END IF;

  IF v_status <> 'active' THEN
    RETURN json_build_object('success', false, 'message', 'Gift code is not active or already redeemed');
  END IF;

  -- Update gift code status
  UPDATE public.gift_codes
  SET status = 'redeemed',
      redeemed_by = p_user_id,
      redeemed_at = now(),
      updated_at = now()
  WHERE id = v_gift_id;

  -- Update or insert user's balance
  IF v_store_id IS NOT NULL THEN
    INSERT INTO public.brand_gift_balances (user_id, store_id, restaurant_id, balance, created_at, updated_at)
    VALUES (p_user_id, v_store_id, NULL, v_amount, now(), now())
    ON CONFLICT (user_id, store_id) WHERE store_id IS NOT NULL
    DO UPDATE SET
      balance = public.brand_gift_balances.balance + v_amount,
      updated_at = now()
    RETURNING balance INTO v_new_balance;
  ELSIF v_restaurant_id IS NOT NULL THEN
    INSERT INTO public.brand_gift_balances (user_id, store_id, restaurant_id, balance, created_at, updated_at)
    VALUES (p_user_id, NULL, v_restaurant_id, v_amount, now(), now())
    ON CONFLICT (user_id, restaurant_id) WHERE restaurant_id IS NOT NULL
    DO UPDATE SET
      balance = public.brand_gift_balances.balance + v_amount,
      updated_at = now()
    RETURNING balance INTO v_new_balance;
  ELSE
    -- General gift card (coins): insert/update public.gift_balances
    INSERT INTO public.gift_balances (user_id, balance, created_at, updated_at)
    VALUES (p_user_id, v_amount, now(), now())
    ON CONFLICT (user_id)
    DO UPDATE SET
      balance = public.gift_balances.balance + v_amount,
      updated_at = now()
    RETURNING balance INTO v_new_balance;
  END IF;

  -- Record the transaction
  INSERT INTO public.gift_transactions (user_id, gift_code_id, amount, type, created_at, store_id, restaurant_id)
  VALUES (p_user_id, v_gift_id, v_amount, 'redemption', now(), v_store_id, v_restaurant_id);

  RETURN json_build_object(
    'success', true,
    'message', 'Gift code redeemed successfully',
    'amount', v_amount,
    'new_balance', v_new_balance
  );
END;
$$;
