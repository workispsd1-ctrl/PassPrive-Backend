-- Fix hard delete failures caused by offer_redemptions entity check conflicts.
-- Root cause: deleting a restaurant triggers FK action setting offer_redemptions.restaurant_id = NULL,
-- which violates offer_redemptions_entity_chk for RESTAURANT rows.

-- 1) Ensure restaurant FK on offer_redemptions cascades delete instead of SET NULL.
do $$
declare
  fk_name text;
begin
  select tc.constraint_name
  into fk_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_schema = kcu.constraint_schema
   and tc.constraint_name = kcu.constraint_name
  join information_schema.constraint_column_usage ccu
    on tc.constraint_schema = ccu.constraint_schema
   and tc.constraint_name = ccu.constraint_name
  where tc.table_schema = 'public'
    and tc.table_name = 'offer_redemptions'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name = 'restaurant_id'
    and ccu.table_schema = 'public'
    and ccu.table_name = 'restaurants'
  limit 1;

  if fk_name is not null then
    execute format('alter table public.offer_redemptions drop constraint %I', fk_name);
  end if;

  begin
    alter table public.offer_redemptions
      add constraint offer_redemptions_restaurant_id_fkey
      foreign key (restaurant_id)
      references public.restaurants(id)
      on delete cascade;
  exception
    when duplicate_object then
      null;
  end;
end $$;

-- 2) Transactional hard-delete helper for API use.
create or replace function public.hard_delete_restaurant_with_dependencies(p_restaurant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
begin
  select exists(
    select 1 from public.restaurants r where r.id = p_restaurant_id
  )
  into v_exists;

  if not v_exists then
    return jsonb_build_object(
      'ok', false,
      'error', 'Restaurant not found',
      'code', 'NOT_FOUND'
    );
  end if;

  -- Delete redemption history for this restaurant first.
  -- This avoids any FK/update behavior that can violate offer_redemptions_entity_chk.
  if to_regclass('public.offer_redemptions') is not null then
    delete from public.offer_redemptions
    where restaurant_id = p_restaurant_id;
  end if;

  -- Remove offer graph owned by this restaurant.
  if to_regclass('public.offers') is not null then
    if to_regclass('public.offer_targets') is not null then
      delete from public.offer_targets t
      using public.offers o
      where t.offer_id = o.id
        and o.owner_entity_type = 'RESTAURANT'
        and o.owner_entity_id = p_restaurant_id;
    end if;

    if to_regclass('public.offer_conditions') is not null then
      delete from public.offer_conditions c
      using public.offers o
      where c.offer_id = o.id
        and o.owner_entity_type = 'RESTAURANT'
        and o.owner_entity_id = p_restaurant_id;
    end if;

    if to_regclass('public.offer_payment_rules') is not null then
      delete from public.offer_payment_rules pr
      using public.offers o
      where pr.offer_id = o.id
        and o.owner_entity_type = 'RESTAURANT'
        and o.owner_entity_id = p_restaurant_id;
    end if;

    if to_regclass('public.offer_bins') is not null then
      delete from public.offer_bins b
      using public.offers o
      where b.offer_id = o.id
        and o.owner_entity_type = 'RESTAURANT'
        and o.owner_entity_id = p_restaurant_id;
    end if;

    if to_regclass('public.offer_usage_limits') is not null then
      delete from public.offer_usage_limits ul
      using public.offers o
      where ul.offer_id = o.id
        and o.owner_entity_type = 'RESTAURANT'
        and o.owner_entity_id = p_restaurant_id;
    end if;

    delete from public.offers
    where owner_entity_type = 'RESTAURANT'
      and owner_entity_id = p_restaurant_id;
  end if;

  delete from public.restaurants
  where id = p_restaurant_id;

  return jsonb_build_object(
    'ok', true,
    'deleted', 'hard',
    'id', p_restaurant_id
  );
exception
  when others then
    return jsonb_build_object(
      'ok', false,
      'error', sqlerrm,
      'code', sqlstate
    );
end;
$$;

grant execute on function public.hard_delete_restaurant_with_dependencies(uuid)
to authenticated, service_role;
