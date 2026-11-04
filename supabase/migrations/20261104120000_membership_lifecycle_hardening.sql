create or replace function public.user_tier_slug(p_user_id uuid)
returns text
language sql
stable
as $$
  select coalesce(
    (
      select s.tier
      from public.users u
      join public.subscription s
        on lower(btrim(s.plan_name)) = lower(btrim(u.membership_tier))
      where u.id = p_user_id
        and s.is_active
        and u.membership_tier is not null
        and lower(btrim(u.membership_tier)) <> 'none'
        and (u.membership_expiry is null or u.membership_expiry > now())
      order by s.sort_order
      limit 1
    ),
    (select s.tier from public.subscription s where s.is_active order by (s.tier = 'free') desc, s.sort_order desc limit 1)
  );
$$;

create or replace function public.membership_duration_days(p_type text)
returns integer
language sql
immutable
as $$
  select case regexp_replace(lower(coalesce(p_type, '')), '\s+', '', 'g')
    when '2' then 2 when '2days' then 2
    when 'week' then 7 when '7days' then 7
    when '10days' then 10 when '15days' then 15 when '20days' then 20
    when 'month' then 30 when '1month' then 30
    when '2months' then 60
    when 'quarter' then 90 when 'quarterly' then 90 when '3month' then 90 when '3months' then 90
    when 'year' then 365 when 'yearly' then 365 when 'annual' then 365 when 'annually' then 365
    when '1year' then 365 when '12month' then 365 when '12months' then 365
    else 30
  end;
$$;

create or replace function public.membership_tier_rank(p_tier text)
returns integer
language sql
immutable
as $$
  select case lower(coalesce(p_tier, '')) when 'black' then 2 when 'plus' then 1 else 0 end;
$$;

create or replace function public.finalize_membership_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.payment_sessions%rowtype;
  v_plan public.subscription%rowtype;
  v_user public.users%rowtype;
  v_now timestamptz := now();
  v_plan_id uuid;
  v_days integer;
  v_paid numeric;
  v_current_tier text;
  v_current_rank integer;
  v_target_rank integer;
  v_active_until timestamptz;
  v_prev jsonb;
  v_prev_per_day numeric;
  v_list_per_day numeric;
  v_bonus_days integer := 0;
  v_mode text;
  v_tier_name text;
  v_started timestamptz;
  v_expiry timestamptz;
  v_result jsonb;
begin
  select * into v_session from public.payment_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Payment session not found' using errcode = 'P0002';
  end if;
  if v_session.payment_context <> 'MEMBERSHIP' then
    raise exception 'Payment session is not a membership payment' using errcode = '22023';
  end if;
  if v_session.status = 'FINALIZED' then
    return jsonb_build_object('duplicate', true, 'membership', v_session.gateway_payload -> 'finalized_membership');
  end if;
  if v_session.status <> 'VERIFIED_SUCCESS' then
    raise exception 'Payment session has not been verified as successful' using errcode = '22023';
  end if;

  v_plan_id := nullif(v_session.gateway_payload -> 'membership_purchase' ->> 'plan_id', '')::uuid;
  select * into v_plan from public.subscription where id = v_plan_id;
  if not found then
    raise exception 'Membership plan not found for finalization' using errcode = 'P0002';
  end if;

  select * into v_user from public.users where id = v_session.user_id for update;
  if not found then
    raise exception 'User not found for finalization' using errcode = 'P0002';
  end if;

  v_days := public.membership_duration_days(v_plan.type);
  v_paid := coalesce(v_session.amount_major, 0);
  v_current_tier := public.user_tier_slug(v_user.id);
  v_current_rank := public.membership_tier_rank(v_current_tier);
  v_target_rank := public.membership_tier_rank(v_plan.tier);
  v_active_until := case when v_user.membership_expiry > v_now then v_user.membership_expiry end;

  if v_current_rank > 0 and v_active_until is not null then
    select s.gateway_payload -> 'finalized_membership' into v_prev
    from public.payment_sessions s
    where s.user_id = v_user.id
      and s.payment_context = 'MEMBERSHIP'
      and s.status = 'FINALIZED'
      and s.id <> v_session.id
      and (s.gateway_payload -> 'finalized_membership' ->> 'membership_expiry')::timestamptz = v_user.membership_expiry
    order by s.updated_at desc
    limit 1;

    if v_prev is not null then
      v_prev_per_day := nullif((v_prev -> 'amount_breakdown' ->> 'final_amount')::numeric, 0)
        / greatest(coalesce(
            nullif((v_prev ->> 'period_days')::numeric, 0),
            nullif((v_prev ->> 'duration_days')::numeric, 0),
            1
          ), 1);
    end if;

    select min(nullif(regexp_replace(s.amount, '[^0-9.]', '', 'g'), '')::numeric / public.membership_duration_days(s.type))
      into v_list_per_day
    from public.subscription s
    where s.is_active and s.tier = v_current_tier;
  end if;

  if v_current_rank = 0 or v_active_until is null then
    v_mode := 'new';
    v_tier_name := btrim(v_plan.plan_name);
    v_started := v_now;
    v_expiry := v_now + make_interval(days => v_days);
  elsif v_current_rank = v_target_rank then
    v_mode := 'renewal';
    v_tier_name := btrim(v_plan.plan_name);
    v_started := coalesce(v_user.membership_started, v_now);
    v_expiry := v_active_until + make_interval(days => v_days);
  elsif v_current_rank < v_target_rank then
    v_mode := 'upgrade';
    v_tier_name := btrim(v_plan.plan_name);
    v_started := v_now;
    if v_prev_per_day is not null and v_paid > 0 then
      v_bonus_days := floor(
        (extract(epoch from (v_active_until - v_now)) / 86400) * v_prev_per_day / (v_paid / v_days)
      )::integer;
    end if;
    v_expiry := v_now + make_interval(days => v_days + greatest(v_bonus_days, 0));
  else
    v_mode := 'downgrade_extended_current';
    v_tier_name := v_user.membership_tier;
    v_started := coalesce(v_user.membership_started, v_now);
    if coalesce(v_list_per_day, 0) > 0 then
      v_bonus_days := floor(v_paid / v_list_per_day)::integer;
    end if;
    v_expiry := v_active_until + make_interval(days => greatest(v_bonus_days, 0));
  end if;

  update public.users
  set membership = 'active',
      membership_tier = v_tier_name,
      membership_started = v_started,
      membership_expiry = v_expiry,
      promo_code_used = v_session.discount_code,
      updated_at = v_now
  where id = v_user.id;

  v_result := jsonb_build_object(
    'applied', true,
    'mode', v_mode,
    'user_id', v_user.id,
    'plan_id', v_plan.id,
    'plan_name', btrim(v_plan.plan_name),
    'membership_tier', v_tier_name,
    'membership_started', v_started,
    'membership_expiry', v_expiry,
    'period_days', v_days,
    'duration_days', v_days,
    'bonus_days', v_bonus_days,
    'previous_tier', v_current_tier,
    'previous_expiry', v_user.membership_expiry,
    'promo_code_used', v_session.discount_code,
    'payment_reference', coalesce(v_session.transaction_index, v_session.bank_reference, v_session.merchant_trace),
    'amount_breakdown', jsonb_build_object(
      'base_amount', coalesce(v_session.original_amount, v_paid),
      'discount_amount', coalesce(v_session.discount_amount, 0),
      'final_amount', v_paid
    )
  );

  update public.payment_sessions
  set status = 'FINALIZED',
      context_reference_id = v_user.id,
      gateway_payload = coalesce(gateway_payload, '{}'::jsonb) || jsonb_build_object('finalized_membership', v_result),
      updated_at = v_now
  where id = v_session.id;

  return jsonb_build_object(
    'duplicate', false,
    'membership', v_result,
    'user', jsonb_build_object(
      'id', v_user.id,
      'membership', 'active',
      'membership_tier', v_tier_name,
      'membership_started', v_started,
      'membership_expiry', v_expiry,
      'promo_code_used', v_session.discount_code,
      'updated_at', v_now
    )
  );
end;
$$;

revoke all on function public.finalize_membership_session(uuid) from public, anon, authenticated;
grant execute on function public.finalize_membership_session(uuid) to service_role;

create or replace function public.merchant_tier_cashback(p_entity_type text, p_entity_id uuid, p_at timestamp with time zone default now(), p_timezone text default 'Indian/Mauritius'::text)
returns table(tier text, plan_name text, base_rate numeric, effective_rate numeric, boost_id uuid, boost_name text)
language sql
stable
as $function$
  select x.tier, x.plan_name, x.base_rate, x.effective_rate, x.boost_id, x.boost_name
  from (
    select distinct on (s.tier)
      s.tier,
      s.plan_name,
      r.base_rate,
      r.effective_rate,
      r.boost_id,
      r.boost_name,
      s.sort_order
    from public.subscription s
    cross join lateral public.resolve_cashback_boost(
      p_entity_type, p_entity_id, s.tier, s.cashback, p_at, null, p_timezone
    ) r
    where s.is_active and s.tier is not null
    order by s.tier, s.sort_order
  ) x
  order by x.sort_order;
$function$;

create or replace function public.sync_subscription_tier_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 or new.tier is null then
    return new;
  end if;

  update public.subscription s
  set plan_name = new.plan_name,
      tags = new.tags,
      benefits = new.benefits,
      deals_per_month = new.deals_per_month,
      deals_per_restaurant_per_month = new.deals_per_restaurant_per_month,
      cashback = new.cashback,
      cashback_label = new.cashback_label,
      cta_label = new.cta_label,
      card_bg_url = new.card_bg_url,
      badge_url = new.badge_url,
      hero_bg_url = new.hero_bg_url,
      theme = new.theme,
      points_expiry_days = new.points_expiry_days,
      points_min_balance_to_burn = new.points_min_balance_to_burn,
      points_max_burn_per_use = new.points_max_burn_per_use,
      points_max_burns_per_window = new.points_max_burns_per_window,
      points_burn_window_days = new.points_burn_window_days,
      updated_at = now()
  where s.tier = new.tier
    and s.id <> new.id
    and (s.plan_name, s.tags, s.benefits, s.deals_per_month, s.deals_per_restaurant_per_month, s.cashback,
         s.cashback_label, s.cta_label, s.card_bg_url, s.badge_url, s.hero_bg_url, s.theme,
         s.points_expiry_days, s.points_min_balance_to_burn, s.points_max_burn_per_use,
         s.points_max_burns_per_window, s.points_burn_window_days)
      is distinct from
        (new.plan_name, new.tags, new.benefits, new.deals_per_month, new.deals_per_restaurant_per_month, new.cashback,
         new.cashback_label, new.cta_label, new.card_bg_url, new.badge_url, new.hero_bg_url, new.theme,
         new.points_expiry_days, new.points_min_balance_to_burn, new.points_max_burn_per_use,
         new.points_max_burns_per_window, new.points_burn_window_days);

  return new;
end;
$$;

revoke all on function public.sync_subscription_tier_fields() from public, anon, authenticated;

drop trigger if exists subscription_sync_tier_fields on public.subscription;
create trigger subscription_sync_tier_fields
after update on public.subscription
for each row execute function public.sync_subscription_tier_fields();

alter function public.membership_duration_days(text) set search_path = public;
alter function public.membership_tier_rank(text) set search_path = public;
alter function public.user_tier_slug(uuid) set search_path = public;
alter function public.merchant_tier_cashback(text, uuid, timestamptz, text) set search_path = public;
