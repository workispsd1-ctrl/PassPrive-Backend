-- Convert chat_messages from one-row-per-message to one-row-per-conversation transcript JSON.

alter table public.chat_messages
  add column if not exists transcript jsonb not null default '[]'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

-- Build transcript arrays from existing per-message rows.
create temporary table if not exists _chat_messages_agg as
select
  conversation_id,
  jsonb_agg(
    jsonb_build_object(
      'id', id,
      'role', role,
      'message', message,
      'message_type', message_type,
      'model', model,
      'token_usage', coalesce(token_usage, '{}'::jsonb),
      'sources', coalesce(sources, '[]'::jsonb),
      'created_at', created_at
    )
    order by created_at asc
  ) as transcript,
  min(created_at) as first_created_at,
  max(created_at) as last_updated_at
from public.chat_messages
group by conversation_id;

-- Keep one row per conversation (latest row), then attach aggregated transcript.
delete from public.chat_messages m
using public.chat_messages newer
where m.conversation_id = newer.conversation_id
  and m.created_at < newer.created_at;

update public.chat_messages m
set
  transcript = coalesce(a.transcript, '[]'::jsonb),
  role = 'system',
  message = '[transcript stored in transcript jsonb]',
  message_type = 'system_note',
  model = null,
  token_usage = '{}'::jsonb,
  sources = '[]'::jsonb,
  created_at = coalesce(a.first_created_at, m.created_at),
  updated_at = coalesce(a.last_updated_at, now())
from _chat_messages_agg a
where a.conversation_id = m.conversation_id;

-- Add unique constraint to enforce one row per conversation.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chat_messages_conversation_id_key'
      and conrelid = 'public.chat_messages'::regclass
  ) then
    alter table public.chat_messages
      add constraint chat_messages_conversation_id_key unique (conversation_id);
  end if;
end $$;

-- Replace index with one fit for conversation-level row.
drop index if exists public.chat_messages_conversation_created_idx;
create index if not exists chat_messages_conversation_updated_idx
  on public.chat_messages using btree (conversation_id, updated_at desc);

-- Trigger for updated_at.
drop trigger if exists set_chat_messages_updated_at on public.chat_messages;
create trigger set_chat_messages_updated_at
before update on public.chat_messages
for each row
execute function public.touch_updated_at();

-- Keep old columns for backward compatibility; no drop yet.
-- Optional future cleanup migration can drop: role, message, message_type, model, token_usage, sources, created_at checks.
