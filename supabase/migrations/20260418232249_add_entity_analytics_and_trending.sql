create extension if not exists "pgcrypto";

-- Canonical behavioral analytics for mixed RESTAURANT/STORE ranking.
-- Raw events are immutable append-only facts. Daily metrics and trending scores are derived.

create table if not exists public.entity_analytics_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('RESTAURANT', 'STORE')),
  entity_id uuid not null,
  event_type text not null check (
    event_type in (
      'IMPRESSION',
      'DETAIL_VIEW',
      'CLICK',
      'SAVE',
      'UNSAVE',
      'SHARE',
      'BOOKING_STARTED',
      'BOOKING_COMPLETED',
      'ORDER_STARTED',
      'ORDER_COMPLETED',
      'OFFER_VIEW',
      'OFFER_REDEEMED',
      'SEARCH_RESULT_VIEW',
      'CALL_TAP',
      'DIRECTIONS_TAP'
    )
  ),
  user_id uuid null references public.users(id) on delete set null,
  session_id text null,
  anonymous_id text null,
  source text not null default 'APP',
  surface text null,
  city text null,
  lat double precision null,
  lng double precision null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default timezone('utc'::text, now()),
  received_at timestamptz not null default timezone('utc'::text, now()),
  constraint entity_analytics_events_actor_chk check (
    user_id is not null
    or nullif(trim(coalesce(session_id, '')), '') is not null
    or nullif(trim(coalesce(anonymous_id, '')), '') is not null
  ),
  constraint entity_analytics_events_coords_chk check (
    (lat is null and lng is null)
    or (
      lat between -90 and 90
      and lng between -180 and 180
    )
  )
);

create index if not exists entity_analytics_events_entity_time_idx
  on public.entity_analytics_events(entity_type, entity_id, occurred_at desc);

create index if not exists entity_analytics_events_event_time_idx
  on public.entity_analytics_events(event_type, occurred_at desc);

create index if not exists entity_analytics_events_user_time_idx
  on public.entity_analytics_events(user_id, occurred_at desc)
  where user_id is not null;

create index if not exists entity_analytics_events_city_time_idx
  on public.entity_analytics_events(lower(city), occurred_at desc)
  where city is not null;

create table if not exists public.entity_daily_metrics (
  metric_date date not null,
  entity_type text not null check (entity_type in ('RESTAURANT', 'STORE')),
  entity_id uuid not null,
  city text null,
  impressions integer not null default 0,
  detail_views integer not null default 0,
  clicks integer not null default 0,
  saves integer not null default 0,
  unsaves integer not null default 0,
  shares integer not null default 0,
  booking_starts integer not null default 0,
  booking_completions integer not null default 0,
  order_starts integer not null default 0,
  order_completions integer not null default 0,
  offer_views integer not null default 0,
  offer_redemptions integer not null default 0,
  search_result_views integer not null default 0,
  call_taps integer not null default 0,
  directions_taps integer not null default 0,
  weighted_engagement numeric(14, 4) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  primary key (metric_date, entity_type, entity_id)
);

create index if not exists entity_daily_metrics_entity_date_idx
  on public.entity_daily_metrics(entity_type, entity_id, metric_date desc);

create index if not exists entity_daily_metrics_city_date_idx
  on public.entity_daily_metrics(lower(city), metric_date desc)
  where city is not null;

create table if not exists public.entity_trending_scores (
  entity_type text not null check (entity_type in ('RESTAURANT', 'STORE')),
  entity_id uuid not null,
  city text null,
  trend_score numeric(14, 4) not null default 0,
  score_24h numeric(14, 4) not null default 0,
  score_7d numeric(14, 4) not null default 0,
  score_30d numeric(14, 4) not null default 0,
  impressions_7d integer not null default 0,
  detail_views_7d integer not null default 0,
  clicks_7d integer not null default 0,
  saves_7d integer not null default 0,
  conversions_7d integer not null default 0,
  offer_redemptions_7d integer not null default 0,
  rating numeric(4, 2) null,
  total_ratings integer not null default 0,
  last_event_at timestamptz null,
  score_components jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default timezone('utc'::text, now()),
  primary key (entity_type, entity_id)
);

create index if not exists entity_trending_scores_city_score_idx
  on public.entity_trending_scores(lower(city), trend_score desc, calculated_at desc);

create index if not exists entity_trending_scores_score_idx
  on public.entity_trending_scores(trend_score desc, calculated_at desc);

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select regexp_replace(lower(coalesce(u.role, '')), '[ _]+', '', 'g')
  from public.users u
  where u.id = auth.uid()
  limit 1;
$$;

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_app_role() in ('admin', 'superadmin'), false);
$$;

grant execute on function public.current_app_role() to authenticated, anon, service_role;
grant execute on function public.is_app_admin() to authenticated, anon, service_role;

create or replace function public.event_weight(p_event_type text)
returns numeric
language sql
immutable
as $$
  select case upper(coalesce(p_event_type, ''))
    when 'IMPRESSION' then 0.10
    when 'SEARCH_RESULT_VIEW' then 0.20
    when 'DETAIL_VIEW' then 1.00
    when 'CLICK' then 1.25
    when 'OFFER_VIEW' then 1.50
    when 'CALL_TAP' then 2.00
    when 'DIRECTIONS_TAP' then 2.00
    when 'SHARE' then 2.50
    when 'SAVE' then 3.00
    when 'UNSAVE' then -2.00
    when 'BOOKING_STARTED' then 3.50
    when 'ORDER_STARTED' then 3.50
    when 'OFFER_REDEEMED' then 5.00
    when 'BOOKING_COMPLETED' then 7.00
    when 'ORDER_COMPLETED' then 7.00
    else 0
  end;
$$;

create or replace function public.rollup_entity_event_to_daily()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_metric_date date;
  v_weight numeric;
begin
  v_metric_date := (new.occurred_at at time zone 'utc')::date;
  v_weight := public.event_weight(new.event_type);

  insert into public.entity_daily_metrics (
    metric_date,
    entity_type,
    entity_id,
    city,
    impressions,
    detail_views,
    clicks,
    saves,
    unsaves,
    shares,
    booking_starts,
    booking_completions,
    order_starts,
    order_completions,
    offer_views,
    offer_redemptions,
    search_result_views,
    call_taps,
    directions_taps,
    weighted_engagement,
    updated_at
  )
  values (
    v_metric_date,
    new.entity_type,
    new.entity_id,
    new.city,
    case when new.event_type = 'IMPRESSION' then 1 else 0 end,
    case when new.event_type = 'DETAIL_VIEW' then 1 else 0 end,
    case when new.event_type = 'CLICK' then 1 else 0 end,
    case when new.event_type = 'SAVE' then 1 else 0 end,
    case when new.event_type = 'UNSAVE' then 1 else 0 end,
    case when new.event_type = 'SHARE' then 1 else 0 end,
    case when new.event_type = 'BOOKING_STARTED' then 1 else 0 end,
    case when new.event_type = 'BOOKING_COMPLETED' then 1 else 0 end,
    case when new.event_type = 'ORDER_STARTED' then 1 else 0 end,
    case when new.event_type = 'ORDER_COMPLETED' then 1 else 0 end,
    case when new.event_type = 'OFFER_VIEW' then 1 else 0 end,
    case when new.event_type = 'OFFER_REDEEMED' then 1 else 0 end,
    case when new.event_type = 'SEARCH_RESULT_VIEW' then 1 else 0 end,
    case when new.event_type = 'CALL_TAP' then 1 else 0 end,
    case when new.event_type = 'DIRECTIONS_TAP' then 1 else 0 end,
    v_weight,
    timezone('utc'::text, now())
  )
  on conflict (metric_date, entity_type, entity_id)
  do update set
    city = coalesce(excluded.city, public.entity_daily_metrics.city),
    impressions = public.entity_daily_metrics.impressions + excluded.impressions,
    detail_views = public.entity_daily_metrics.detail_views + excluded.detail_views,
    clicks = public.entity_daily_metrics.clicks + excluded.clicks,
    saves = public.entity_daily_metrics.saves + excluded.saves,
    unsaves = public.entity_daily_metrics.unsaves + excluded.unsaves,
    shares = public.entity_daily_metrics.shares + excluded.shares,
    booking_starts = public.entity_daily_metrics.booking_starts + excluded.booking_starts,
    booking_completions = public.entity_daily_metrics.booking_completions + excluded.booking_completions,
    order_starts = public.entity_daily_metrics.order_starts + excluded.order_starts,
    order_completions = public.entity_daily_metrics.order_completions + excluded.order_completions,
    offer_views = public.entity_daily_metrics.offer_views + excluded.offer_views,
    offer_redemptions = public.entity_daily_metrics.offer_redemptions + excluded.offer_redemptions,
    search_result_views = public.entity_daily_metrics.search_result_views + excluded.search_result_views,
    call_taps = public.entity_daily_metrics.call_taps + excluded.call_taps,
    directions_taps = public.entity_daily_metrics.directions_taps + excluded.directions_taps,
    weighted_engagement = public.entity_daily_metrics.weighted_engagement + excluded.weighted_engagement,
    updated_at = timezone('utc'::text, now());

  return new;
end;
$$;

drop trigger if exists trg_entity_analytics_events_rollup on public.entity_analytics_events;
create trigger trg_entity_analytics_events_rollup
after insert on public.entity_analytics_events
for each row
execute function public.rollup_entity_event_to_daily();

create or replace function public.record_entity_analytics_event(
  p_entity_type text,
  p_entity_id uuid,
  p_event_type text,
  p_user_id uuid default null,
  p_session_id text default null,
  p_anonymous_id text default null,
  p_source text default 'APP',
  p_surface text default null,
  p_city text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_metadata jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default timezone('utc'::text, now())
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_entity_type text := upper(trim(coalesce(p_entity_type, '')));
  v_event_type text := upper(trim(coalesce(p_event_type, '')));
begin
  insert into public.entity_analytics_events (
    entity_type,
    entity_id,
    event_type,
    user_id,
    session_id,
    anonymous_id,
    source,
    surface,
    city,
    lat,
    lng,
    metadata,
    occurred_at
  )
  values (
    v_entity_type,
    p_entity_id,
    v_event_type,
    coalesce(p_user_id, auth.uid()),
    nullif(trim(coalesce(p_session_id, '')), ''),
    nullif(trim(coalesce(p_anonymous_id, '')), ''),
    coalesce(nullif(trim(p_source), ''), 'APP'),
    nullif(trim(coalesce(p_surface, '')), ''),
    nullif(trim(coalesce(p_city, '')), ''),
    p_lat,
    p_lng,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_occurred_at, timezone('utc'::text, now()))
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.refresh_entity_trending_scores(
  p_as_of timestamptz default timezone('utc'::text, now())
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  with metrics as (
    select
      entity_type,
      entity_id,
      max(city) filter (where city is not null) as city,
      sum(weighted_engagement) filter (where metric_date >= (p_as_of at time zone 'utc')::date) as score_24h,
      sum(weighted_engagement) filter (where metric_date >= ((p_as_of at time zone 'utc')::date - interval '6 days')) as score_7d,
      sum(weighted_engagement) filter (where metric_date >= ((p_as_of at time zone 'utc')::date - interval '29 days')) as score_30d,
      sum(impressions) filter (where metric_date >= ((p_as_of at time zone 'utc')::date - interval '6 days')) as impressions_7d,
      sum(detail_views) filter (where metric_date >= ((p_as_of at time zone 'utc')::date - interval '6 days')) as detail_views_7d,
      sum(clicks) filter (where metric_date >= ((p_as_of at time zone 'utc')::date - interval '6 days')) as clicks_7d,
      sum(saves - unsaves) filter (where metric_date >= ((p_as_of at time zone 'utc')::date - interval '6 days')) as saves_7d,
      sum(booking_completions + order_completions) filter (where metric_date >= ((p_as_of at time zone 'utc')::date - interval '6 days')) as conversions_7d,
      sum(offer_redemptions) filter (where metric_date >= ((p_as_of at time zone 'utc')::date - interval '6 days')) as offer_redemptions_7d,
      max(updated_at) as last_metric_at
    from public.entity_daily_metrics
    where metric_date >= ((p_as_of at time zone 'utc')::date - interval '29 days')
    group by entity_type, entity_id
  ),
  scored as (
    select
      m.*,
      (
        coalesce(m.score_24h, 0) * 0.55
        + coalesce(m.score_7d, 0) * 0.35
        + coalesce(m.score_30d, 0) * 0.10
      )::numeric(14, 4) as trend_score
    from metrics m
  ),
  upserted as (
    insert into public.entity_trending_scores (
      entity_type,
      entity_id,
      city,
      trend_score,
      score_24h,
      score_7d,
      score_30d,
      impressions_7d,
      detail_views_7d,
      clicks_7d,
      saves_7d,
      conversions_7d,
      offer_redemptions_7d,
      last_event_at,
      score_components,
      calculated_at
    )
    select
      entity_type,
      entity_id,
      city,
      trend_score,
      coalesce(score_24h, 0),
      coalesce(score_7d, 0),
      coalesce(score_30d, 0),
      coalesce(impressions_7d, 0),
      coalesce(detail_views_7d, 0),
      coalesce(clicks_7d, 0),
      coalesce(saves_7d, 0),
      coalesce(conversions_7d, 0),
      coalesce(offer_redemptions_7d, 0),
      last_metric_at,
      jsonb_build_object(
        'score_24h', coalesce(score_24h, 0),
        'score_7d', coalesce(score_7d, 0),
        'score_30d', coalesce(score_30d, 0),
        'formula', '0.55*24h + 0.35*7d + 0.10*30d'
      ),
      p_as_of
    from scored
    on conflict (entity_type, entity_id)
    do update set
      city = coalesce(excluded.city, public.entity_trending_scores.city),
      trend_score = excluded.trend_score,
      score_24h = excluded.score_24h,
      score_7d = excluded.score_7d,
      score_30d = excluded.score_30d,
      impressions_7d = excluded.impressions_7d,
      detail_views_7d = excluded.detail_views_7d,
      clicks_7d = excluded.clicks_7d,
      saves_7d = excluded.saves_7d,
      conversions_7d = excluded.conversions_7d,
      offer_redemptions_7d = excluded.offer_redemptions_7d,
      last_event_at = excluded.last_event_at,
      score_components = excluded.score_components,
      calculated_at = excluded.calculated_at
    returning 1
  )
  select count(*) into v_count from upserted;

  return v_count;
end;
$$;

grant execute on function public.event_weight(text) to authenticated, anon, service_role;
grant execute on function public.record_entity_analytics_event(
  text, uuid, text, uuid, text, text, text, text, text, double precision, double precision, jsonb, timestamptz
) to authenticated, anon, service_role;
grant execute on function public.refresh_entity_trending_scores(timestamptz) to authenticated, service_role;

alter table public.entity_analytics_events enable row level security;
alter table public.entity_daily_metrics enable row level security;
alter table public.entity_trending_scores enable row level security;

drop policy if exists "entity_analytics_events_insert_public" on public.entity_analytics_events;
create policy "entity_analytics_events_insert_public"
on public.entity_analytics_events
for insert
to anon, authenticated
with check (
  user_id is null or user_id = auth.uid() or public.is_app_admin()
);

drop policy if exists "entity_analytics_events_select_own_or_admin" on public.entity_analytics_events;
create policy "entity_analytics_events_select_own_or_admin"
on public.entity_analytics_events
for select
to authenticated
using (
  public.is_app_admin()
  or user_id = auth.uid()
);

drop policy if exists "entity_analytics_events_no_client_update" on public.entity_analytics_events;
create policy "entity_analytics_events_no_client_update"
on public.entity_analytics_events
for update
to authenticated
using (public.is_app_admin())
with check (public.is_app_admin());

drop policy if exists "entity_analytics_events_no_client_delete" on public.entity_analytics_events;
create policy "entity_analytics_events_no_client_delete"
on public.entity_analytics_events
for delete
to authenticated
using (public.is_app_admin());

drop policy if exists "entity_daily_metrics_select_public" on public.entity_daily_metrics;
create policy "entity_daily_metrics_select_public"
on public.entity_daily_metrics
for select
to anon, authenticated
using (true);

drop policy if exists "entity_daily_metrics_admin_write" on public.entity_daily_metrics;
create policy "entity_daily_metrics_admin_write"
on public.entity_daily_metrics
for all
to authenticated
using (public.is_app_admin())
with check (public.is_app_admin());

drop policy if exists "entity_trending_scores_select_public" on public.entity_trending_scores;
create policy "entity_trending_scores_select_public"
on public.entity_trending_scores
for select
to anon, authenticated
using (true);

drop policy if exists "entity_trending_scores_admin_write" on public.entity_trending_scores;
create policy "entity_trending_scores_admin_write"
on public.entity_trending_scores
for all
to authenticated
using (public.is_app_admin())
with check (public.is_app_admin());
