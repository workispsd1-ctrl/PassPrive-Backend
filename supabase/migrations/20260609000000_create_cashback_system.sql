-- Alter users table to add cashback_enabled column if it does not exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'users' 
      AND column_name = 'cashback_enabled'
  ) THEN
    ALTER TABLE public.users ADD COLUMN cashback_enabled BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

-- 1. Create cashback_rules table (Versioned Configuration)
CREATE TABLE IF NOT EXISTS public.cashback_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  min_purchase_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  max_use_per_transaction NUMERIC(10, 2) NOT NULL DEFAULT 999999.99,
  max_use_per_month NUMERIC(10, 2) NOT NULL DEFAULT 999999.99,
  max_transactions_per_month INTEGER NOT NULL DEFAULT 999999,
  expiry_days INTEGER NOT NULL DEFAULT 30,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

  CONSTRAINT cashback_rules_pkey PRIMARY KEY (id),
  CONSTRAINT cashback_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users (id) ON DELETE SET NULL
) TABLESPACE pg_default;

-- Create unique index to ensure only one active config at a time
CREATE UNIQUE INDEX IF NOT EXISTS cashback_rules_active_idx ON public.cashback_rules (is_active) WHERE is_active = true;

-- Insert default rules if the table is empty
INSERT INTO public.cashback_rules (min_purchase_amount, max_use_per_transaction, max_use_per_month, max_transactions_per_month, expiry_days, is_active)
SELECT 0.00, 1000.00, 5000.00, 10, 30, true
WHERE NOT EXISTS (SELECT 1 FROM public.cashback_rules);

-- 2. Create cashback_lots table (Lot-based balance for expiration tracking)
CREATE TABLE IF NOT EXISTS public.cashback_lots (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  remaining_amount NUMERIC(10, 2) NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

  CONSTRAINT cashback_lots_pkey PRIMARY KEY (id),
  CONSTRAINT cashback_lots_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT cashback_lots_amount_chk CHECK (amount >= 0.00),
  CONSTRAINT cashback_lots_remaining_amount_chk CHECK (remaining_amount >= 0.00 AND remaining_amount <= amount)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS cashback_lots_user_active_idx ON public.cashback_lots (user_id, expires_at) WHERE remaining_amount > 0.00;

-- 3. Create cashback_transactions table (Audit log)
CREATE TABLE IF NOT EXISTS public.cashback_transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  amount NUMERIC(10, 2) NOT NULL, -- positive for credit, negative for spend
  type TEXT NOT NULL, -- 'credit', 'spend', 'expiry'
  payment_session_id UUID NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

  CONSTRAINT cashback_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT cashback_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT cashback_transactions_payment_session_id_fkey FOREIGN KEY (payment_session_id) REFERENCES public.payment_sessions (id) ON DELETE SET NULL,
  CONSTRAINT cashback_transactions_type_chk CHECK (type = ANY (ARRAY['credit'::text, 'spend'::text, 'expiry'::text]))
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS cashback_transactions_user_month_idx ON public.cashback_transactions (user_id, type, created_at);

-- 4. Create cashback_lot_consumptions table (Detailed deduction log)
CREATE TABLE IF NOT EXISTS public.cashback_lot_consumptions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL,
  lot_id UUID NOT NULL,
  amount_consumed NUMERIC(10, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

  CONSTRAINT cashback_lot_consumptions_pkey PRIMARY KEY (id),
  CONSTRAINT cashback_lot_consumptions_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.cashback_transactions (id) ON DELETE CASCADE,
  CONSTRAINT cashback_lot_consumptions_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.cashback_lots (id) ON DELETE CASCADE,
  CONSTRAINT cashback_lot_consumptions_amount_consumed_chk CHECK (amount_consumed > 0.00)
) TABLESPACE pg_default;

-- Create update triggers
CREATE TRIGGER trg_cashback_rules_set_updated_at BEFORE UPDATE ON cashback_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_cashback_lots_set_updated_at BEFORE UPDATE ON cashback_lots FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. Stored Procedure/Function for Atomic Cashback Redemption
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

  -- 5. Validate user's monthly rules
  SELECT COUNT(id), COALESCE(SUM(ABS(amount)), 0.00)
  INTO v_monthly_count, v_monthly_amount
  FROM public.cashback_transactions
  WHERE user_id = p_user_id
    AND type = 'spend'
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

  -- 6. Lock and fetch user's active balance
  SELECT COALESCE(SUM(remaining_amount), 0.00) INTO v_available_balance
  FROM public.cashback_lots
  WHERE user_id = p_user_id
    AND remaining_amount > 0.00
    AND expires_at > now();

  IF v_available_balance < p_amount THEN
    RETURN json_build_object(
      'success', false, 
      'message', format('Insufficient cashback balance (requested %s, available %s)', p_amount, v_available_balance)
    );
  END IF;

  -- 7. Deduct balance using FIFO (oldest expires first)
  INSERT INTO public.cashback_transactions (user_id, amount, type, payment_session_id, created_at)
  VALUES (p_user_id, -p_amount, 'spend', p_payment_session_id, now())
  RETURNING id INTO v_tx_id;

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

  -- 8. Return final success payload with new balance
  RETURN json_build_object(
    'success', true,
    'message', 'Cashback points applied successfully',
    'amount', p_amount,
    'new_balance', v_available_balance - p_amount
  );
END;
$$;
