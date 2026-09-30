-- XL-ENT (CashMag / Fulle API) booking sync.
--
-- Bookings are written from several places (backend, partner web, partner app,
-- customer app), so the POS sync is driven from the database: a trigger enqueues
-- a job into pos_sync_jobs whenever a booking for an XL-ENT restaurant is created
-- or a POS-relevant field changes. The backend worker claims jobs, reconciles the
-- booking with CashMag and records the outcome on the booking row.

-- 1. Sync status on bookings -------------------------------------------------
ALTER TABLE public.restaurant_bookings
  ADD COLUMN IF NOT EXISTS pos_provider text NULL,
  ADD COLUMN IF NOT EXISTS pos_sync_status text NULL,
  ADD COLUMN IF NOT EXISTS pos_sync_error text NULL,
  ADD COLUMN IF NOT EXISTS pos_synced_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_bookings_pos_sync_status_check'
  ) THEN
    ALTER TABLE public.restaurant_bookings
      ADD CONSTRAINT restaurant_bookings_pos_sync_status_check
      CHECK (pos_sync_status IS NULL OR pos_sync_status IN ('pending', 'synced', 'failed', 'skipped'));
  END IF;
END $$;

-- 2. Outbox table --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.restaurant_bookings(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  provider_name text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one open job per booking; the worker always syncs the latest booking state.
CREATE UNIQUE INDEX IF NOT EXISTS pos_sync_jobs_open_booking_idx
  ON public.pos_sync_jobs (booking_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS pos_sync_jobs_due_idx
  ON public.pos_sync_jobs (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pos_sync_jobs_restaurant_idx
  ON public.pos_sync_jobs (restaurant_id, created_at DESC);

-- Service role only (contains no secrets, but nothing outside the backend needs it).
ALTER TABLE public.pos_sync_jobs ENABLE ROW LEVEL SECURITY;

-- 3. Enqueue helper --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_pos_sync_job(p_booking_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id uuid;
  v_provider text;
BEGIN
  SELECT b.restaurant_id INTO v_restaurant_id
  FROM public.restaurant_bookings b
  WHERE b.id = p_booking_id;

  IF v_restaurant_id IS NULL THEN
    RETURN;
  END IF;

  SELECT tp.provider_name INTO v_provider
  FROM public.restaurant_till_providers tp
  WHERE tp.restaurant_id = v_restaurant_id
    AND tp.provider_name = 'xlent'
    AND tp.is_enabled = true
  LIMIT 1;

  IF v_provider IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.pos_sync_jobs (booking_id, restaurant_id, provider_name, reason)
  VALUES (p_booking_id, v_restaurant_id, v_provider, p_reason)
  ON CONFLICT (booking_id) WHERE status IN ('pending', 'processing')
  DO UPDATE SET
    -- A processing job keeps its lock. Bumping updated_at tells the worker the
    -- booking changed mid-sync, so it re-queues the job instead of closing it.
    reason = EXCLUDED.reason,
    next_attempt_at = CASE WHEN pos_sync_jobs.status = 'pending' THEN now() ELSE pos_sync_jobs.next_attempt_at END,
    updated_at = now();

  UPDATE public.restaurant_bookings
  SET pos_provider = v_provider,
      pos_sync_status = 'pending'
  WHERE id = p_booking_id
    AND (pos_sync_status IS DISTINCT FROM 'pending' OR pos_provider IS DISTINCT FROM v_provider);
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_pos_sync_job(uuid, text) FROM PUBLIC, anon, authenticated;

-- 4. Trigger on bookings ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_restaurant_bookings_enqueue_pos_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.enqueue_pos_sync_job(NEW.id, 'created');
    RETURN NEW;
  END IF;

  -- Only POS-relevant changes. The worker's own writes (external_pos_*, pos_sync_*)
  -- must not re-trigger a sync.
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.booking_date IS DISTINCT FROM OLD.booking_date
     OR NEW.booking_time IS DISTINCT FROM OLD.booking_time
     OR NEW.party_size IS DISTINCT FROM OLD.party_size
     OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
     OR NEW.special_request IS DISTINCT FROM OLD.special_request THEN
    PERFORM public.enqueue_pos_sync_job(
      NEW.id,
      CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN 'status:' || coalesce(NEW.status, 'null') ELSE 'updated' END
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_restaurant_bookings_enqueue_pos_sync ON public.restaurant_bookings;
CREATE TRIGGER trg_restaurant_bookings_enqueue_pos_sync
  AFTER INSERT OR UPDATE ON public.restaurant_bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_restaurant_bookings_enqueue_pos_sync();

-- 5. Worker helpers (called by the backend with the service role) ---------------
-- Claims due jobs with SKIP LOCKED so several backend instances can run the worker.
-- Jobs stuck in 'processing' for > 5 minutes (crashed worker) are reclaimed.
CREATE OR REPLACE FUNCTION public.claim_pos_sync_jobs(p_limit integer DEFAULT 10, p_booking_id uuid DEFAULT NULL)
RETURNS SETOF public.pos_sync_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT j.id
    FROM public.pos_sync_jobs j
    WHERE (
        (j.status = 'pending' AND j.next_attempt_at <= now())
        OR (j.status = 'processing' AND j.locked_at < now() - interval '5 minutes')
      )
      AND (p_booking_id IS NULL OR j.booking_id = p_booking_id)
    ORDER BY j.next_attempt_at
    LIMIT greatest(p_limit, 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.pos_sync_jobs j
  SET status = 'processing',
      locked_at = now(),
      attempts = j.attempts + 1,
      updated_at = now()
  FROM due
  WHERE j.id = due.id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_pos_sync_jobs(integer, uuid) FROM PUBLIC, anon, authenticated;

-- Admin "resync" and retry of failed jobs.
CREATE OR REPLACE FUNCTION public.requeue_pos_sync_job(p_booking_id uuid, p_reason text DEFAULT 'manual')
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.enqueue_pos_sync_job(p_booking_id, p_reason);
$$;

REVOKE ALL ON FUNCTION public.requeue_pos_sync_job(uuid, text) FROM PUBLIC, anon, authenticated;

-- 6. Provider config table: service role only -----------------------------------
-- config holds the merchant API key, so it must never be readable by clients.
ALTER TABLE public.restaurant_till_providers ENABLE ROW LEVEL SECURITY;

-- The existing 'xlent' row was created by the admin toggle with the PassPrive
-- restaurant id as the POS id and no API key. Disable it until it is configured
-- through the admin XL-ENT panel (API key + point of sale).
UPDATE public.restaurant_till_providers
SET is_enabled = false, updated_at = now()
WHERE provider_name = 'xlent'
  AND (config IS NULL OR NOT (config ? 'mutualKey'))
  AND is_enabled = true;
