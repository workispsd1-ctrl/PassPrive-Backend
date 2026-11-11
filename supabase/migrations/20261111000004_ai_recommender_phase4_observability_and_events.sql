-- Migration: Phase 4 (Production-Aligned) - AI Recommendation Observability & Logging (ai_turns & ai_card_events)
-- Description:
--   1. Creates `public.ai_turns` table to log every conversational interaction, token metrics, latency breakdown, and fallback events.
--   2. Links authenticated users via `user_id` (auth.users) while maintaining `user_hash` for anonymous/guest privacy.
--   3. Creates `public.ai_card_events` table to track card impressions, clicks, menu views, and booking conversions.
--   4. Adds performance indexes for session lookups and conversion analytics.

-- 1. CREATE ai_turns TABLE
create table if not exists public.ai_turns (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  user_id uuid references auth.users(id) on delete set null, -- Optional link for authenticated users
  user_hash text not null,                                   -- Pseudonymized identifier for privacy & guests
  created_at timestamptz not null default now(),
  prompt_version text not null,                              -- E.g. 'concierge_prompt_1.0'
  model text not null,                                       -- E.g. 'gpt-4o-mini' or 'gemini-1.5-flash'
  user_message text,                                         -- Natural language request
  tool_calls jsonb,                                          -- Captured tool invocations, filters, and args
  final_reply jsonb,                                         -- Rendered response payload (intro, picks, chips)
  relaxed text[] default '{}',                               -- Filters loosened if thin results occurred
  fallback_used boolean not null default false,
  validation_failures int not null default 0,
  tokens_in int,
  tokens_out int,
  ms_total int,
  ms_llm1 int,
  ms_tool int,
  ms_llm2 int
);

-- Indexes for turn performance & troubleshooting
create index if not exists idx_ai_turns_created_at
  on public.ai_turns (created_at desc);

create index if not exists idx_ai_turns_session_id
  on public.ai_turns (session_id);

create index if not exists idx_ai_turns_user_id
  on public.ai_turns (user_id)
  where user_id is not null;

create index if not exists idx_ai_turns_user_hash
  on public.ai_turns (user_hash);

-- 2. CREATE ai_card_events TABLE
create table if not exists public.ai_card_events (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references public.ai_turns(id) on delete cascade,
  restaurant_id uuid references public.restaurants(id) on delete set null,
  position smallint check (position >= 0),
  event text not null check (event in ('impression', 'tap', 'menu_view', 'book_start', 'booked')),
  at timestamptz not null default now()
);

-- Indexes for analytics & booking conversion funnels
create index if not exists idx_ai_card_events_turn_id
  on public.ai_card_events (turn_id);

create index if not exists idx_ai_card_events_restaurant_event
  on public.ai_card_events (restaurant_id, event);

create index if not exists idx_ai_card_events_at
  on public.ai_card_events (at desc);

-- 3. ROW LEVEL SECURITY (RLS)
alter table public.ai_turns enable row level security;
alter table public.ai_card_events enable row level security;

-- Allow service_role full administrative access
drop policy if exists "service_role_ai_turns_policy" on public.ai_turns;
create policy "service_role_ai_turns_policy"
  on public.ai_turns
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service_role_ai_card_events_policy" on public.ai_card_events;
create policy "service_role_ai_card_events_policy"
  on public.ai_card_events
  for all
  to service_role
  using (true)
  with check (true);
