CREATE OR REPLACE FUNCTION public.set_merchant_mips_credentials(
  p_kind text,
  p_merchant_id uuid,
  p_id_merchant text,
  p_app_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text;
  v_secret text;
  v_id uuid;
BEGIN
  IF p_kind NOT IN ('restaurant', 'store') THEN
    RAISE EXCEPTION 'Invalid merchant kind %', p_kind USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_id_merchant), '') = '' OR coalesce(btrim(p_app_id), '') = '' THEN
    RAISE EXCEPTION 'Merchant ID and App ID are required' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'restaurant' AND NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = p_merchant_id) THEN
    RAISE EXCEPTION 'Restaurant % not found', p_merchant_id USING ERRCODE = 'P0002';
  END IF;
  IF p_kind = 'store' AND NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_merchant_id) THEN
    RAISE EXCEPTION 'Store % not found', p_merchant_id USING ERRCODE = 'P0002';
  END IF;

  v_name := format('mips:%s:%s', p_kind, p_merchant_id);
  v_secret := jsonb_build_object('id_merchant', btrim(p_id_merchant), 'id_entity', btrim(p_app_id))::text;

  SELECT s.id INTO v_id FROM vault.secrets s WHERE s.name = v_name;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(v_secret, v_name, 'MIPS merchant credentials');
  ELSE
    PERFORM vault.update_secret(v_id, v_secret);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_merchant_mips_credentials(p_kind text, p_merchant_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ds.decrypted_secret::jsonb
  FROM vault.decrypted_secrets ds
  WHERE ds.name = format('mips:%s:%s', p_kind, p_merchant_id);
$$;

CREATE OR REPLACE FUNCTION public.delete_merchant_mips_credentials(p_kind text, p_merchant_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM vault.secrets s WHERE s.name = format('mips:%s:%s', p_kind, p_merchant_id);
$$;

REVOKE ALL ON FUNCTION public.set_merchant_mips_credentials(text, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_merchant_mips_credentials(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_merchant_mips_credentials(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_merchant_mips_credentials(text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_merchant_mips_credentials(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_merchant_mips_credentials(text, uuid) TO service_role;
