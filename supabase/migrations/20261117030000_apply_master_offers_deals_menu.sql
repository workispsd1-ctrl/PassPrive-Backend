CREATE OR REPLACE FUNCTION public.apply_master_settings_to_branches(p_source uuid, p_what text)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_targets uuid[];
  v_target uuid;
  v_deal record;
  v_copy_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF p_what NOT IN ('hours', 'booking_rules', 'offers', 'deals', 'menu') THEN
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

  ELSIF p_what = 'booking_rules' THEN
    UPDATE public.restaurants r
    SET avg_duration_minutes = s.avg_duration_minutes,
        max_bookings_per_slot = s.max_bookings_per_slot,
        advance_booking_days = s.advance_booking_days
    FROM public.restaurants s
    WHERE s.id = p_source AND r.id = ANY (v_targets);

  ELSIF p_what = 'offers' THEN
    DELETE FROM public.restaurant_offers o WHERE o.restaurant_id = ANY (v_targets);
    INSERT INTO public.restaurant_offers
      (restaurant_id, title, description, badge_text, offer_type, discount_value, min_spend, start_at, end_at, is_active, metadata, applies_to)
    SELECT t.id, o.title, o.description, o.badge_text, o.offer_type, o.discount_value, o.min_spend, o.start_at, o.end_at, o.is_active, o.metadata, o.applies_to
    FROM unnest(v_targets) AS t(id)
    CROSS JOIN public.restaurant_offers o
    WHERE o.restaurant_id = p_source
    ORDER BY o.created_at;

  ELSIF p_what = 'menu' THEN
    UPDATE public.restaurants r
    SET menu_json = s.menu_json
    FROM public.restaurants s
    WHERE s.id = p_source AND r.id = ANY (v_targets);
    DELETE FROM public.restaurant_media_assets m
    WHERE m.restaurant_id = ANY (v_targets) AND m.asset_type = 'menu';
    INSERT INTO public.restaurant_media_assets (restaurant_id, asset_type, file_url, file_path, sort_order, is_active)
    SELECT t.id, m.asset_type, m.file_url, m.file_path, m.sort_order, m.is_active
    FROM unnest(v_targets) AS t(id)
    CROSS JOIN public.restaurant_media_assets m
    WHERE m.restaurant_id = p_source AND m.asset_type = 'menu';

  ELSE
    FOREACH v_target IN ARRAY v_targets LOOP
      UPDATE public.restaurant_deals d
      SET is_active = false
      WHERE d.restaurant_id = v_target
        AND d.metadata ? 'copied_from'
        AND NOT EXISTS (
          SELECT 1 FROM public.restaurant_deals s
          WHERE s.restaurant_id = p_source AND s.id::text = d.metadata->>'copied_from'
        );

      FOR v_deal IN SELECT * FROM public.restaurant_deals s WHERE s.restaurant_id = p_source ORDER BY s.created_at LOOP
        SELECT d.id INTO v_copy_id
        FROM public.restaurant_deals d
        WHERE d.restaurant_id = v_target AND d.metadata->>'copied_from' = v_deal.id::text
        LIMIT 1;

        IF v_copy_id IS NULL THEN
          INSERT INTO public.restaurant_deals
            (restaurant_id, title, description, badge_text, image_url, terms, deal_type, currency_code, min_spend, max_spend,
             min_party_size, starts_at, ends_at, days_of_week, start_time, end_time, blackout_dates, dine_in, takeaway, delivery,
             total_redemption_limit, per_user_limit, per_user_period, per_day_limit, advance_booking_required, is_stackable,
             priority, is_active, metadata, applies_to)
          VALUES
            (v_target, v_deal.title, v_deal.description, v_deal.badge_text, v_deal.image_url, v_deal.terms, v_deal.deal_type,
             v_deal.currency_code, v_deal.min_spend, v_deal.max_spend, v_deal.min_party_size, v_deal.starts_at, v_deal.ends_at,
             v_deal.days_of_week, v_deal.start_time, v_deal.end_time, v_deal.blackout_dates, v_deal.dine_in, v_deal.takeaway,
             v_deal.delivery, v_deal.total_redemption_limit, v_deal.per_user_limit, v_deal.per_user_period, v_deal.per_day_limit,
             v_deal.advance_booking_required, v_deal.is_stackable, v_deal.priority, v_deal.is_active,
             coalesce(v_deal.metadata, '{}'::jsonb) - 'copied_from' || jsonb_build_object('copied_from', v_deal.id::text),
             v_deal.applies_to)
          RETURNING id INTO v_copy_id;
        ELSE
          UPDATE public.restaurant_deals d
          SET title = v_deal.title, description = v_deal.description, badge_text = v_deal.badge_text, image_url = v_deal.image_url,
              terms = v_deal.terms, deal_type = v_deal.deal_type, currency_code = v_deal.currency_code, min_spend = v_deal.min_spend,
              max_spend = v_deal.max_spend, min_party_size = v_deal.min_party_size, starts_at = v_deal.starts_at,
              ends_at = v_deal.ends_at, days_of_week = v_deal.days_of_week, start_time = v_deal.start_time,
              end_time = v_deal.end_time, blackout_dates = v_deal.blackout_dates, dine_in = v_deal.dine_in,
              takeaway = v_deal.takeaway, delivery = v_deal.delivery, total_redemption_limit = v_deal.total_redemption_limit,
              per_user_limit = v_deal.per_user_limit, per_user_period = v_deal.per_user_period,
              per_day_limit = v_deal.per_day_limit, advance_booking_required = v_deal.advance_booking_required,
              is_stackable = v_deal.is_stackable, priority = v_deal.priority, is_active = v_deal.is_active,
              metadata = coalesce(v_deal.metadata, '{}'::jsonb) - 'copied_from' || jsonb_build_object('copied_from', v_deal.id::text),
              applies_to = v_deal.applies_to
          WHERE d.id = v_copy_id;
          DELETE FROM public.restaurant_deal_tiers dt WHERE dt.deal_id = v_copy_id;
        END IF;

        INSERT INTO public.restaurant_deal_tiers
          (deal_id, tier, benefit_percent, benefit_amount, max_discount_amount, deal_price, buy_quantity, get_quantity,
           free_item_label, per_user_limit, is_active, sort_order)
        SELECT v_copy_id, dt.tier, dt.benefit_percent, dt.benefit_amount, dt.max_discount_amount, dt.deal_price, dt.buy_quantity,
               dt.get_quantity, dt.free_item_label, dt.per_user_limit, dt.is_active, dt.sort_order
        FROM public.restaurant_deal_tiers dt
        WHERE dt.deal_id = v_deal.id;

        v_copy_id := NULL;
      END LOOP;
    END LOOP;
  END IF;

  RETURN cardinality(v_targets);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_master_settings_to_branches(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_master_settings_to_branches(uuid, text) TO authenticated;
