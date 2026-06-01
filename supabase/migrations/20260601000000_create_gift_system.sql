-- 1. Create gift_codes table
CREATE TABLE IF NOT EXISTS public.gift_codes (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  created_by UUID NOT NULL,
  redeemed_by UUID NULL,
  payment_session_id UUID NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  redeemed_at TIMESTAMP WITH TIME ZONE NULL,
  
  CONSTRAINT gift_codes_pkey PRIMARY KEY (id),
  CONSTRAINT gift_codes_code_key UNIQUE (code),
  CONSTRAINT gift_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT gift_codes_redeemed_by_fkey FOREIGN KEY (redeemed_by) REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT gift_codes_payment_session_id_fkey FOREIGN KEY (payment_session_id) REFERENCES public.payment_sessions (id) ON DELETE SET NULL,
  CONSTRAINT gift_codes_status_chk CHECK (status = ANY (ARRAY['active'::text, 'redeemed'::text, 'cancelled'::text]))
) TABLESPACE pg_default;

-- Create indexes for performance
CREATE UNIQUE INDEX IF NOT EXISTS gift_codes_code_idx ON public.gift_codes (code);
CREATE INDEX IF NOT EXISTS gift_codes_created_by_idx ON public.gift_codes (created_by);
CREATE INDEX IF NOT EXISTS gift_codes_redeemed_by_idx ON public.gift_codes (redeemed_by);

-- 2. Create gift_balances table (User Wallet)
CREATE TABLE IF NOT EXISTS public.gift_balances (
  user_id UUID NOT NULL,
  balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  CONSTRAINT gift_balances_pkey PRIMARY KEY (user_id),
  CONSTRAINT gift_balances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT gift_balances_balance_chk CHECK (balance >= 0.00)
) TABLESPACE pg_default;

-- 3. Create gift_transactions table (Audit log)
CREATE TABLE IF NOT EXISTS public.gift_transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  gift_code_id UUID NULL,
  amount NUMERIC(10, 2) NOT NULL,
  type TEXT NOT NULL, -- 'redemption', 'spend' etc.
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  CONSTRAINT gift_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT gift_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT gift_transactions_gift_code_id_fkey FOREIGN KEY (gift_code_id) REFERENCES public.gift_codes (id) ON DELETE SET NULL,
  CONSTRAINT gift_transactions_type_chk CHECK (type = ANY (ARRAY['redemption'::text, 'spend'::text]))
) TABLESPACE pg_default;

-- Alter payment_sessions constraint to support GIFT_PURCHASE context
ALTER TABLE public.payment_sessions
  DROP CONSTRAINT IF EXISTS payment_sessions_payment_context_check;

ALTER TABLE public.payment_sessions
  ADD CONSTRAINT payment_sessions_payment_context_check CHECK (
    payment_context = ANY (ARRAY['BOOKING'::text, 'BILL_PAYMENT'::text, 'MEMBERSHIP'::text, 'TABLE_ORDERS'::text, 'GIFT_PURCHASE'::text])
  );

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
      AND (restaurant_id IS NULL)
      AND (store_id IS NULL)
    )
  );

-- Create trigger for set_updated_at on gift_codes and gift_balances
CREATE TRIGGER trg_gift_codes_set_updated_at BEFORE UPDATE ON gift_codes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_gift_balances_set_updated_at BEFORE UPDATE ON gift_balances FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Create RPC function to redeem gift codes atomically
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
BEGIN
  -- Select and lock the gift code row to prevent concurrent redemptions
  SELECT id, amount, status INTO v_gift_id, v_amount, v_status
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
  INSERT INTO public.gift_balances (user_id, balance, created_at, updated_at)
  VALUES (p_user_id, v_amount, now(), now())
  ON CONFLICT (user_id)
  DO UPDATE SET
    balance = public.gift_balances.balance + v_amount,
    updated_at = now()
  RETURNING balance INTO v_new_balance;

  -- Record the transaction
  INSERT INTO public.gift_transactions (user_id, gift_code_id, amount, type, created_at)
  VALUES (p_user_id, v_gift_id, v_amount, 'redemption', now());

  RETURN json_build_object(
    'success', true,
    'message', 'Gift code redeemed successfully',
    'amount', v_amount,
    'new_balance', v_new_balance
  );
END;
$$;

