-- XL-ENT POS: security hardening.
--
-- 1. Merchant API keys are stored encrypted in Supabase Vault, never in plaintext
--    table columns. Only the service role can set/read them, via two functions.
-- 2. POS tables are closed to client roles at the GRANT level as well as by RLS.
-- 3. Client roles cannot write POS sync columns on restaurant_bookings (customers
--    may update their own bookings, so without this they could point a booking at
--    another CashMag booking id and have the worker cancel it).
-- 4. Trigger/worker functions are not callable over PostgREST.

-- 1. API keys in Vault -----------------------------------------------------------
ALTER TABLE public.restaurant_till_providers
  ADD COLUMN IF NOT EXISTS api_key_secret_id uuid NULL;

COMMENT ON COLUMN public.restaurant_till_providers.api_key_secret_id IS
  'vault.secrets id of the merchant API key. Read/write only via get_/set_till_provider_api_key (service_role).';

CREATE OR REPLACE FUNCTION public.set_till_provider_api_key(
  p_restaurant_id uuid,
  p_provider text,
  p_api_key text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret_id uuid;
  v_name text := format('till_provider:%s:%s', p_provider, p_restaurant_id);
BEGIN
  IF p_api_key IS NULL OR length(btrim(p_api_key)) = 0 THEN
    RAISE EXCEPTION 'API key must not be empty' USING ERRCODE = '22023';
  END IF;

  SELECT tp.api_key_secret_id INTO v_secret_id
  FROM public.restaurant_till_providers tp
  WHERE tp.restaurant_id = p_restaurant_id AND tp.provider_name = p_provider
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No % provider row for restaurant %', p_provider, p_restaurant_id USING ERRCODE = 'P0002';
  END IF;

  IF v_secret_id IS NOT NULL AND EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = v_secret_id) THEN
    PERFORM vault.update_secret(v_secret_id, btrim(p_api_key));
  ELSE
    -- A stale secret with the same name (e.g. row deleted and re-created) is replaced.
    DELETE FROM vault.secrets s WHERE s.name = v_name;
    v_secret_id := vault.create_secret(btrim(p_api_key), v_name, 'Merchant POS API key');
    UPDATE public.restaurant_till_providers
    SET api_key_secret_id = v_secret_id, updated_at = now()
    WHERE restaurant_id = p_restaurant_id AND provider_name = p_provider;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_till_provider_api_key(p_restaurant_id uuid, p_provider text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ds.decrypted_secret
  FROM public.restaurant_till_providers tp
  JOIN vault.decrypted_secrets ds ON ds.id = tp.api_key_secret_id
  WHERE tp.restaurant_id = p_restaurant_id AND tp.provider_name = p_provider;
$$;

-- Remove the Vault secret together with its provider row (incl. restaurant cascade).
CREATE OR REPLACE FUNCTION public.trg_till_providers_delete_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.api_key_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets s WHERE s.id = OLD.api_key_secret_id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_till_providers_delete_secret ON public.restaurant_till_providers;
CREATE TRIGGER trg_till_providers_delete_secret
  AFTER DELETE ON public.restaurant_till_providers
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_till_providers_delete_secret();

-- Move any plaintext keys into Vault, then forbid plaintext keys in config.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT restaurant_id, provider_name,
           coalesce(config->>'mutualKey', config->>'mutual_key', config->>'apiKey', config->>'api_key') AS key
    FROM public.restaurant_till_providers
    WHERE config ?| array['mutualKey', 'mutual_key', 'apiKey', 'api_key']
  LOOP
    IF r.key IS NOT NULL AND length(btrim(r.key)) > 0 THEN
      PERFORM public.set_till_provider_api_key(r.restaurant_id, r.provider_name, r.key);
    END IF;
    UPDATE public.restaurant_till_providers
    SET config = config - 'mutualKey' - 'mutual_key' - 'apiKey' - 'api_key'
    WHERE restaurant_id = r.restaurant_id AND provider_name = r.provider_name;
  END LOOP;
END $$;

ALTER TABLE public.restaurant_till_providers
  DROP CONSTRAINT IF EXISTS restaurant_till_providers_no_plaintext_secret;
ALTER TABLE public.restaurant_till_providers
  ADD CONSTRAINT restaurant_till_providers_no_plaintext_secret
  CHECK (config IS NULL OR NOT (config ?| array['mutualKey', 'mutual_key', 'apiKey', 'api_key']));

-- The enqueue trigger must only queue for fully configured providers.
CREATE OR REPLACE FUNCTION public.enqueue_pos_sync_job(p_booking_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
    AND tp.api_key_secret_id IS NOT NULL
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
    next_attempt_at = CASE WHEN public.pos_sync_jobs.status = 'pending' THEN now() ELSE public.pos_sync_jobs.next_attempt_at END,
    updated_at = now();

  UPDATE public.restaurant_bookings
  SET pos_provider = v_provider,
      pos_sync_status = 'pending'
  WHERE id = p_booking_id
    AND (pos_sync_status IS DISTINCT FROM 'pending' OR pos_provider IS DISTINCT FROM v_provider);
END;
$$;

-- Pin search_path on the other definer functions from the previous migration.
ALTER FUNCTION public.trg_restaurant_bookings_enqueue_pos_sync() SET search_path = '';
ALTER FUNCTION public.claim_pos_sync_jobs(integer, uuid) SET search_path = '';
ALTER FUNCTION public.requeue_pos_sync_job(uuid, text) SET search_path = '';

-- 2. Client roles: no access to POS tables ----------------------------------------
REVOKE ALL ON TABLE public.restaurant_till_providers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pos_sync_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.restaurant_till_providers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pos_sync_jobs TO service_role;

-- Explicit deny policies document intent (service_role bypasses RLS).
DROP POLICY IF EXISTS restaurant_till_providers_deny_clients ON public.restaurant_till_providers;
CREATE POLICY restaurant_till_providers_deny_clients ON public.restaurant_till_providers
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS pos_sync_jobs_deny_clients ON public.pos_sync_jobs;
CREATE POLICY pos_sync_jobs_deny_clients ON public.pos_sync_jobs
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- 3. POS sync columns on bookings are server-owned ---------------------------------
CREATE OR REPLACE FUNCTION public.trg_restaurant_bookings_protect_pos_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Requests from the app/partner clients run as anon/authenticated. The backend
  -- (service_role) and the SECURITY DEFINER sync functions (postgres) may write.
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.external_pos_id := NULL;
      NEW.external_pos_reference := NULL;
      NEW.pos_provider := NULL;
      NEW.pos_sync_status := NULL;
      NEW.pos_sync_error := NULL;
      NEW.pos_synced_at := NULL;
    ELSE
      NEW.external_pos_id := OLD.external_pos_id;
      NEW.external_pos_reference := OLD.external_pos_reference;
      NEW.pos_provider := OLD.pos_provider;
      NEW.pos_sync_status := OLD.pos_sync_status;
      NEW.pos_sync_error := OLD.pos_sync_error;
      NEW.pos_synced_at := OLD.pos_synced_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_restaurant_bookings_protect_pos_columns ON public.restaurant_bookings;
CREATE TRIGGER trg_restaurant_bookings_protect_pos_columns
  BEFORE INSERT OR UPDATE ON public.restaurant_bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_restaurant_bookings_protect_pos_columns();

-- 4. No function in this feature is callable by client roles -----------------------
REVOKE ALL ON FUNCTION public.set_till_provider_api_key(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_till_provider_api_key(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_till_providers_delete_secret() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_pos_sync_job(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_restaurant_bookings_enqueue_pos_sync() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_restaurant_bookings_protect_pos_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_pos_sync_jobs(integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requeue_pos_sync_job(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.set_till_provider_api_key(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_till_provider_api_key(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pos_sync_jobs(integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_pos_sync_job(uuid, text) TO service_role;
