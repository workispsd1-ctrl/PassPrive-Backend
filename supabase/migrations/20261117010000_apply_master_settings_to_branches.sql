CREATE OR REPLACE FUNCTION public.apply_master_settings_to_branches(p_source uuid, p_what text)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_targets uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF p_what NOT IN ('hours', 'booking_rules') THEN
    RAISE EXCEPTION 'Unknown setting %', p_what USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = p_source AND r.owner_user_id = v_uid) THEN
    RAISE EXCEPTION 'Only the master account can apply settings to all branches' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(array_agg(r.id), '{}') INTO v_targets
  FROM public.restaurants r
  WHERE r.owner_user_id = v_uid AND r.id <> p_source;

  IF cardinality(v_targets) = 0 THEN
    RETURN 0;
  END IF;

  IF p_what = 'hours' THEN
    DELETE FROM public.restaurant_opening_hours h WHERE h.restaurant_id = ANY (v_targets);
    INSERT INTO public.restaurant_opening_hours (restaurant_id, day_of_week, open_time, close_time, is_closed)
    SELECT t.id, h.day_of_week, h.open_time, h.close_time, h.is_closed
    FROM unnest(v_targets) AS t(id)
    CROSS JOIN public.restaurant_opening_hours h
    WHERE h.restaurant_id = p_source;
  ELSE
    UPDATE public.restaurants r
    SET avg_duration_minutes = s.avg_duration_minutes,
        max_bookings_per_slot = s.max_bookings_per_slot,
        advance_booking_days = s.advance_booking_days
    FROM public.restaurants s
    WHERE s.id = p_source AND r.id = ANY (v_targets);
  END IF;

  RETURN cardinality(v_targets);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_master_settings_to_branches(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_master_settings_to_branches(uuid, text) TO authenticated;
