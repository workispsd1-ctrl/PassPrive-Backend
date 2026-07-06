-- Distinguish membership vs merchant-funded (and manual) credits so a single
-- payment session can carry more than one credit lot without colliding.
ALTER TABLE public.cashback_transactions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'membership';

-- Idempotency: each source credits a given payment session at most once.
DROP INDEX IF EXISTS cashback_tx_session_credit_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS cashback_tx_session_source_credit_uidx
  ON public.cashback_transactions (payment_session_id, source)
  WHERE type = 'credit' AND payment_session_id IS NOT NULL;
