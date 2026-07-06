-- 1. Create cashback_accounts table
CREATE TABLE IF NOT EXISTS public.cashback_accounts (
    user_id UUID NOT NULL PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    available_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    locked_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
) TABLESPACE pg_default;

-- Add updated_at trigger to cashback_accounts
CREATE TRIGGER trg_cashback_accounts_set_updated_at BEFORE UPDATE ON cashback_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. Alter cashback_transactions to support ledger balance auditing
ALTER TABLE public.cashback_transactions
  ADD COLUMN IF NOT EXISTS balance_before NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS balance_after NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3. Create cashback_idempotency table
CREATE TABLE IF NOT EXISTS public.cashback_idempotency (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    transaction_id UUID REFERENCES public.cashback_transactions(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
) TABLESPACE pg_default;

-- 4. Initialize cashback_accounts from existing active, non-expired lots
INSERT INTO public.cashback_accounts (user_id, available_balance, locked_balance, version, created_at, updated_at)
SELECT user_id, COALESCE(SUM(remaining_amount), 0.00), 0.00, 0, now(), now()
FROM public.cashback_lots
WHERE remaining_amount > 0.00 AND expires_at > now()
GROUP BY user_id
ON CONFLICT (user_id) DO NOTHING;

-- 5. Alter gift tables
ALTER TABLE public.gift_balances
  ADD COLUMN IF NOT EXISTS locked_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.brand_gift_balances
  ADD COLUMN IF NOT EXISTS locked_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

-- Alter gift_transactions to support ledger balance auditing
ALTER TABLE public.gift_transactions
  ADD COLUMN IF NOT EXISTS balance_before NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS balance_after NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Alter gift_transactions check constraint to support spends
ALTER TABLE public.gift_transactions DROP CONSTRAINT IF EXISTS gift_transactions_type_chk;
ALTER TABLE public.gift_transactions ADD CONSTRAINT gift_transactions_type_chk CHECK (type = ANY (ARRAY['redemption'::text, 'spend'::text]));

-- 6. Create gift_idempotency table
CREATE TABLE IF NOT EXISTS public.gift_idempotency (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    transaction_id UUID REFERENCES public.gift_transactions(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
) TABLESPACE pg_default;


-- 7. Stored Procedure: get_or_update_cashback_balance (Thread-safe Lazy Expiration)
CREATE OR REPLACE FUNCTION public.get_or_update_cashback_balance(p_user_id UUID)
RETURNS NUMERIC(10, 2)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_balance NUMERIC(10, 2);
  lot_record RECORD;
  v_tx_id UUID;
  v_before NUMERIC(10, 2);
  v_after NUMERIC(10, 2);
BEGIN
  -- Insert account if not exists, and lock it FOR UPDATE
  INSERT INTO public.cashback_accounts (user_id, available_balance, locked_balance, version, created_at, updated_at)
  VALUES (p_user_id, 0.00, 0.00, 0, now(), now())
  ON CONFLICT (user_id) DO NOTHING;

  SELECT available_balance INTO v_balance
  FROM public.cashback_accounts
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Find expired lots that still have remaining_amount > 0
  FOR lot_record IN
    SELECT id, remaining_amount
    FROM public.cashback_lots
    WHERE user_id = p_user_id
      AND remaining_amount > 0.00
      AND expires_at <= now()
    ORDER BY expires_at ASC
    FOR UPDATE
  LOOP
    v_before := v_balance;
    v_balance := v_balance - lot_record.remaining_amount;
    v_after := v_balance;

    -- Insert expiry transaction in ledger
    INSERT INTO public.cashback_transactions (user_id, amount, type, created_at, balance_before, balance_after, status, metadata)
    VALUES (p_user_id, -lot_record.remaining_amount, 'expiry', now(), v_before, v_after, 'SUCCESS', jsonb_build_object('expired_lot_id', lot_record.id))
    RETURNING id INTO v_tx_id;

    -- Record consumption
    INSERT INTO public.cashback_lot_consumptions (transaction_id, lot_id, amount_consumed, created_at)
    VALUES (v_tx_id, lot_record.id, lot_record.remaining_amount, now());

    -- Mark lot as expired (remaining_amount = 0)
    UPDATE public.cashback_lots
    SET remaining_amount = 0.00,
        updated_at = now()
    WHERE id = lot_record.id;
  END LOOP;

  -- Update the cashback account available_balance
  UPDATE public.cashback_accounts
  SET available_balance = v_balance,
      updated_at = now()
  WHERE user_id = p_user_id;

  RETURN v_balance;
END;
$$;


-- 8. Stored Procedure: redeem_cashback_points (Thread-safe + Idempotent)
CREATE OR REPLACE FUNCTION public.redeem_cashback_points(
  p_user_id UUID,
  p_amount NUMERIC(10, 2),
  p_merchant_user_id UUID,
  p_bill_amount NUMERIC(10, 2),
  p_payment_session_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_min_purchase_amount NUMERIC(10, 2);
  v_max_use_per_transaction NUMERIC(10, 2);
  v_max_use_per_month NUMERIC(10, 2);
  v_max_transactions_per_month INTEGER;
  v_merchant_enabled BOOLEAN;
  v_monthly_count INTEGER;
  v_monthly_amount NUMERIC(10, 2);
  v_available_balance NUMERIC(10, 2);
  v_to_deduct NUMERIC(10, 2);
  v_deducted NUMERIC(10, 2);
  v_tx_id UUID;
  lot_record RECORD;
  v_before NUMERIC(10, 2);
  v_after NUMERIC(10, 2);
  v_idem_key VARCHAR(255);
  v_existing_tx_id UUID;
BEGIN
  -- 1. Get current active config rules
  SELECT min_purchase_amount, max_use_per_transaction, max_use_per_month, max_transactions_per_month
  INTO v_min_purchase_amount, v_max_use_per_transaction, v_max_use_per_month, v_max_transactions_per_month
  FROM public.cashback_rules
  WHERE is_active = true
  LIMIT 1;

  IF v_min_purchase_amount IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Active cashback rules configuration not found');
  END IF;

  -- 2. Validate merchant applicability
  SELECT cashback_enabled INTO v_merchant_enabled FROM public.users WHERE id = p_merchant_user_id;
  IF v_merchant_enabled IS NOT TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Merchant is not whitelisted or eligible for cashback');
  END IF;

  -- 3. Validate minimum purchase amount
  IF p_bill_amount < v_min_purchase_amount THEN
    RETURN json_build_object(
      'success', false, 
      'message', format('Purchase amount %s is below the minimum required amount of %s to use cashback', p_bill_amount, v_min_purchase_amount)
    );
  END IF;

  -- 4. Validate transaction single-use limit
  IF p_amount > v_max_use_per_transaction THEN
    RETURN json_build_object(
      'success', false, 
      'message', format('Requested cashback amount %s exceeds single transaction limit of %s', p_amount, v_max_use_per_transaction)
    );
  END IF;

  -- 5. Lock and check/insert idempotency
  IF p_payment_session_id IS NOT NULL THEN
    v_idem_key := 'spend_cashback_' || p_payment_session_id::text;
    SELECT transaction_id INTO v_existing_tx_id FROM public.cashback_idempotency WHERE idempotency_key = v_idem_key;
    IF v_existing_tx_id IS NOT NULL THEN
      SELECT balance_after INTO v_after FROM public.cashback_transactions WHERE id = v_existing_tx_id;
      RETURN json_build_object(
        'success', true,
        'message', 'Cashback points applied successfully (idempotent)',
        'amount', p_amount,
        'new_balance', COALESCE(v_after, 0.00)
      );
    END IF;
  END IF;

  -- 6. Lock and fetch user's active balance (with lazy expiration)
  v_available_balance := public.get_or_update_cashback_balance(p_user_id);

  -- 7. Validate sufficient balance
  IF v_available_balance < p_amount THEN
    RETURN json_build_object(
      'success', false, 
      'message', format('Insufficient cashback balance (requested %s, available %s)', p_amount, v_available_balance)
    );
  END IF;

  -- 8. Validate user's monthly limits
  SELECT COUNT(id), COALESCE(SUM(ABS(amount)), 0.00)
  INTO v_monthly_count, v_monthly_amount
  FROM public.cashback_transactions
  WHERE user_id = p_user_id
    AND type = 'spend'
    AND status = 'SUCCESS'
    AND created_at >= date_trunc('month', now());

  IF v_monthly_count >= v_max_transactions_per_month THEN
    RETURN json_build_object(
      'success', false, 
      'message', format('Monthly cashback transaction limit of %s uses has been reached', v_max_transactions_per_month)
    );
  END IF;

  IF v_monthly_amount + p_amount > v_max_use_per_month THEN
    RETURN json_build_object(
      'success', false, 
      'message', format('Monthly cashback spend limit of %s has been exceeded (already used %s this month)', v_max_use_per_month, v_monthly_amount)
    );
  END IF;

  -- 9. Insert transaction ledger entry
  v_before := v_available_balance;
  v_after := v_available_balance - p_amount;

  INSERT INTO public.cashback_transactions (user_id, amount, type, payment_session_id, created_at, balance_before, balance_after, status, metadata)
  VALUES (p_user_id, -p_amount, 'spend', p_payment_session_id, now(), v_before, v_after, 'SUCCESS', jsonb_build_object('merchant_user_id', p_merchant_user_id, 'bill_amount', p_bill_amount))
  RETURNING id INTO v_tx_id;

  -- 10. Record idempotency if key exists
  IF v_idem_key IS NOT NULL THEN
    INSERT INTO public.cashback_idempotency (idempotency_key, transaction_id, created_at)
    VALUES (v_idem_key, v_tx_id, now());
  END IF;

  -- 11. Deduct balance using FIFO (oldest expires first)
  v_to_deduct := p_amount;

  FOR lot_record IN
    SELECT id, remaining_amount
    FROM public.cashback_lots
    WHERE user_id = p_user_id
      AND remaining_amount > 0.00
      AND expires_at > now()
    ORDER BY expires_at ASC
    FOR UPDATE
  LOOP
    IF v_to_deduct <= 0.00 THEN
      EXIT;
    END IF;

    IF lot_record.remaining_amount >= v_to_deduct THEN
      v_deducted := v_to_deduct;
      v_to_deduct := 0.00;
    ELSE
      v_deducted := lot_record.remaining_amount;
      v_to_deduct := v_to_deduct - lot_record.remaining_amount;
    END IF;

    UPDATE public.cashback_lots
    SET remaining_amount = remaining_amount - v_deducted,
        updated_at = now()
    WHERE id = lot_record.id;

    INSERT INTO public.cashback_lot_consumptions (transaction_id, lot_id, amount_consumed, created_at)
    VALUES (v_tx_id, lot_record.id, v_deducted, now());
  END LOOP;

  -- 12. Update the cashback account balance
  UPDATE public.cashback_accounts
  SET available_balance = v_after,
      updated_at = now()
  WHERE user_id = p_user_id;

  -- 13. Return success payload
  RETURN json_build_object(
    'success', true,
    'message', 'Cashback points applied successfully',
    'amount', p_amount,
    'new_balance', v_after
  );
END;
$$;


-- 9. Stored Procedure: credit_cashback_points_secure (Thread-safe + Idempotent Credit)
CREATE OR REPLACE FUNCTION public.credit_cashback_points_secure(
  p_user_id UUID,
  p_amount NUMERIC(10, 2),
  p_payment_session_id UUID,
  p_idempotency_key VARCHAR(255)
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_available_balance NUMERIC(10, 2);
  v_before NUMERIC(10, 2);
  v_after NUMERIC(10, 2);
  v_tx_id UUID;
  v_lot_id UUID;
  v_existing_tx_id UUID;
  v_expiry_days INTEGER;
  v_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
  -- 1. Check idempotency
  IF p_idempotency_key IS NOT NULL THEN
    SELECT transaction_id INTO v_existing_tx_id FROM public.cashback_idempotency WHERE idempotency_key = p_idempotency_key;
    IF v_existing_tx_id IS NOT NULL THEN
      SELECT balance_after INTO v_after FROM public.cashback_transactions WHERE id = v_existing_tx_id;
      RETURN json_build_object(
        'success', true,
        'message', 'Cashback points credited successfully (idempotent)',
        'amount', p_amount,
        'new_balance', COALESCE(v_after, 0.00)
      );
    END IF;
  END IF;

  -- 2. Lock account and run lazy-expiry
  v_available_balance := public.get_or_update_cashback_balance(p_user_id);

  -- 3. Fetch rules for expiry days
  SELECT expiry_days INTO v_expiry_days FROM public.cashback_rules WHERE is_active = true LIMIT 1;
  IF v_expiry_days IS NULL THEN
    v_expiry_days := 30;
  END IF;
  v_expires_at := now() + (v_expiry_days || ' days')::interval;

  -- 4. Calculate balances
  v_before := v_available_balance;
  v_after := v_available_balance + p_amount;

  -- 5. Insert transaction ledger entry
  INSERT INTO public.cashback_transactions (user_id, amount, type, payment_session_id, created_at, balance_before, balance_after, status, metadata)
  VALUES (p_user_id, p_amount, 'credit', p_payment_session_id, now(), v_before, v_after, 'SUCCESS', jsonb_build_object('expiry_days', v_expiry_days))
  RETURNING id INTO v_tx_id;

  -- 6. Insert idempotency record
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.cashback_idempotency (idempotency_key, transaction_id, created_at)
    VALUES (p_idempotency_key, v_tx_id, now());
  END IF;

  -- 7. Insert the lot
  INSERT INTO public.cashback_lots (user_id, amount, remaining_amount, expires_at, created_at, updated_at)
  VALUES (p_user_id, p_amount, p_amount, v_expires_at, now(), now())
  RETURNING id INTO v_lot_id;

  -- 8. Update account balance
  UPDATE public.cashback_accounts
  SET available_balance = v_after,
      updated_at = now()
  WHERE user_id = p_user_id;

  RETURN json_build_object(
    'success', true,
    'message', 'Cashback points credited successfully',
    'amount', p_amount,
    'new_balance', v_after,
    'lot_id', v_lot_id,
    'transaction_id', v_tx_id
  );
END;
$$;


-- 10. Stored Procedure: redeem_gift_code (Thread-safe + Idempotent Gift redemption)
CREATE OR REPLACE FUNCTION public.redeem_gift_code(p_code text, p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_gift_id uuid;
  v_amount numeric(10, 2);
  v_status text;
  v_store_id uuid;
  v_restaurant_id uuid;
  v_before numeric(10, 2);
  v_after numeric(10, 2);
  v_idem_key varchar(255);
  v_existing_tx_id uuid;
  v_tx_id uuid;
BEGIN
  -- 1. Select and lock the gift code row to prevent concurrent redemptions
  SELECT id, amount, status, store_id, restaurant_id INTO v_gift_id, v_amount, v_status, v_store_id, v_restaurant_id
  FROM public.gift_codes
  WHERE code = p_code
  FOR UPDATE;

  -- Verify existence and status
  IF v_gift_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Gift code not found');
  END IF;

  -- Check if already redeemed
  IF v_status <> 'active' THEN
    -- Check idempotency
    v_idem_key := 'redeem_gift_code_' || v_gift_id::text;
    SELECT transaction_id INTO v_existing_tx_id FROM public.gift_idempotency WHERE idempotency_key = v_idem_key;
    IF v_existing_tx_id IS NOT NULL THEN
      SELECT balance_after INTO v_after FROM public.gift_transactions WHERE id = v_existing_tx_id;
      RETURN json_build_object(
        'success', true,
        'message', 'Gift code redeemed successfully (idempotent)',
        'amount', v_amount,
        'new_balance', COALESCE(v_after, 0.00)
      );
    END IF;
    
    RETURN json_build_object('success', false, 'message', 'Gift code is not active or already redeemed');
  END IF;

  -- 2. Lock user's gift balance account FOR UPDATE
  IF v_store_id IS NOT NULL THEN
    INSERT INTO public.brand_gift_balances (user_id, store_id, restaurant_id, balance, locked_balance, version, created_at, updated_at)
    VALUES (p_user_id, v_store_id, NULL, 0.00, 0.00, 0, now(), now())
    ON CONFLICT (user_id, store_id) WHERE store_id IS NOT NULL DO NOTHING;

    SELECT balance INTO v_before
    FROM public.brand_gift_balances
    WHERE user_id = p_user_id AND store_id = v_store_id
    FOR UPDATE;

    v_after := v_before + v_amount;

    UPDATE public.brand_gift_balances
    SET balance = v_after,
        updated_at = now()
    WHERE user_id = p_user_id AND store_id = v_store_id;

  ELSIF v_restaurant_id IS NOT NULL THEN
    INSERT INTO public.brand_gift_balances (user_id, store_id, restaurant_id, balance, locked_balance, version, created_at, updated_at)
    VALUES (p_user_id, NULL, v_restaurant_id, 0.00, 0.00, 0, now(), now())
    ON CONFLICT (user_id, restaurant_id) WHERE restaurant_id IS NOT NULL DO NOTHING;

    SELECT balance INTO v_before
    FROM public.brand_gift_balances
    WHERE user_id = p_user_id AND restaurant_id = v_restaurant_id
    FOR UPDATE;

    v_after := v_before + v_amount;

    UPDATE public.brand_gift_balances
    SET balance = v_after,
        updated_at = now()
    WHERE user_id = p_user_id AND restaurant_id = v_restaurant_id;

  ELSE
    INSERT INTO public.gift_balances (user_id, balance, locked_balance, version, created_at, updated_at)
    VALUES (p_user_id, 0.00, 0.00, 0, now(), now())
    ON CONFLICT (user_id) DO NOTHING;

    SELECT balance INTO v_before
    FROM public.gift_balances
    WHERE user_id = p_user_id
    FOR UPDATE;

    v_after := v_before + v_amount;

    UPDATE public.gift_balances
    SET balance = v_after,
        updated_at = now()
    WHERE user_id = p_user_id;
  END IF;

  -- 3. Update gift code status
  UPDATE public.gift_codes
  SET status = 'redeemed',
      redeemed_by = p_user_id,
      redeemed_at = now(),
      updated_at = now()
  WHERE id = v_gift_id;

  -- 4. Record the transaction
  INSERT INTO public.gift_transactions (user_id, gift_code_id, amount, type, created_at, store_id, restaurant_id, balance_before, balance_after, status)
  VALUES (p_user_id, v_gift_id, v_amount, 'redemption', now(), v_store_id, v_restaurant_id, v_before, v_after, 'SUCCESS')
  RETURNING id INTO v_tx_id;

  -- 5. Record idempotency key
  v_idem_key := 'redeem_gift_code_' || v_gift_id::text;
  INSERT INTO public.gift_idempotency (idempotency_key, transaction_id, created_at)
  VALUES (v_idem_key, v_tx_id, now());

  RETURN json_build_object(
    'success', true,
    'message', 'Gift code redeemed successfully',
    'amount', v_amount,
    'new_balance', v_after
  );
END;
$$;


-- 11. Stored Procedure: spend_gift_balance (Thread-safe + Idempotent Gift spend)
CREATE OR REPLACE FUNCTION public.spend_gift_balance(
  p_user_id UUID,
  p_amount NUMERIC(10, 2),
  p_store_id UUID,
  p_restaurant_id UUID,
  p_payment_session_id UUID,
  p_idempotency_key VARCHAR(255)
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_before NUMERIC(10, 2);
  v_after NUMERIC(10, 2);
  v_tx_id UUID;
  v_existing_tx_id UUID;
BEGIN
  -- 1. Check idempotency
  IF p_idempotency_key IS NOT NULL THEN
    SELECT transaction_id INTO v_existing_tx_id FROM public.gift_idempotency WHERE idempotency_key = p_idempotency_key;
    IF v_existing_tx_id IS NOT NULL THEN
      SELECT balance_after INTO v_after FROM public.gift_transactions WHERE id = v_existing_tx_id;
      RETURN json_build_object(
        'success', true,
        'message', 'Gift balance spent successfully (idempotent)',
        'amount', p_amount,
        'new_balance', COALESCE(v_after, 0.00)
      );
    END IF;
  END IF;

  -- 2. Lock relevant wallet row FOR UPDATE
  IF p_store_id IS NOT NULL THEN
    SELECT balance INTO v_before
    FROM public.brand_gift_balances
    WHERE user_id = p_user_id AND store_id = p_store_id
    FOR UPDATE;
    
    IF v_before IS NULL THEN
      RETURN json_build_object('success', false, 'message', 'No gift balance found for this store');
    END IF;

    IF v_before < p_amount THEN
      RETURN json_build_object('success', false, 'message', format('Insufficient store gift balance (available %s, requested %s)', v_before, p_amount));
    END IF;

    v_after := v_before - p_amount;

    UPDATE public.brand_gift_balances
    SET balance = v_after,
        updated_at = now()
    WHERE user_id = p_user_id AND store_id = p_store_id;

  ELSIF p_restaurant_id IS NOT NULL THEN
    SELECT balance INTO v_before
    FROM public.brand_gift_balances
    WHERE user_id = p_user_id AND restaurant_id = p_restaurant_id
    FOR UPDATE;
    
    IF v_before IS NULL THEN
      RETURN json_build_object('success', false, 'message', 'No gift balance found for this restaurant');
    END IF;

    IF v_before < p_amount THEN
      RETURN json_build_object('success', false, 'message', format('Insufficient restaurant gift balance (available %s, requested %s)', v_before, p_amount));
    END IF;

    v_after := v_before - p_amount;

    UPDATE public.brand_gift_balances
    SET balance = v_after,
        updated_at = now()
    WHERE user_id = p_user_id AND restaurant_id = p_restaurant_id;

  ELSE
    SELECT balance INTO v_before
    FROM public.gift_balances
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_before IS NULL THEN
      RETURN json_build_object('success', false, 'message', 'No general gift balance found');
    END IF;

    IF v_before < p_amount THEN
      RETURN json_build_object('success', false, 'message', format('Insufficient general gift balance (available %s, requested %s)', v_before, p_amount));
    END IF;

    v_after := v_before - p_amount;

    UPDATE public.gift_balances
    SET balance = v_after,
        updated_at = now()
    WHERE user_id = p_user_id;
  END IF;

  -- 3. Record transaction
  INSERT INTO public.gift_transactions (user_id, amount, type, created_at, store_id, restaurant_id, balance_before, balance_after, status, metadata)
  VALUES (p_user_id, -p_amount, 'spend', now(), p_store_id, p_restaurant_id, v_before, v_after, 'SUCCESS', jsonb_build_object('payment_session_id', p_payment_session_id))
  RETURNING id INTO v_tx_id;

  -- 4. Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.gift_idempotency (idempotency_key, transaction_id, created_at)
    VALUES (p_idempotency_key, v_tx_id, now());
  END IF;

  RETURN json_build_object(
    'success', true,
    'message', 'Gift balance spent successfully',
    'amount', p_amount,
    'new_balance', v_after
  );
END;
$$;
