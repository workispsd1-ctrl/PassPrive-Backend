create extension if not exists "pgcrypto";

create table if not exists public.help_topics (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  title text not null,
  content text not null,
  tags text[] not null default '{}'::text[],
  is_published boolean not null default true,
  display_order integer not null default 0,
  source text null,
  created_by uuid null references auth.users(id) on delete set null,
  updated_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint help_category_not_empty check (length(trim(both from category)) > 0),
  constraint help_content_not_empty check (length(trim(both from content)) > 0),
  constraint help_title_not_empty check (length(trim(both from title)) > 0)
);

create index if not exists help_topics_updated_at_idx
  on public.help_topics using btree (updated_at desc);

create index if not exists help_topics_category_idx
  on public.help_topics using btree (category, is_published, display_order);

create index if not exists help_topics_tags_gin_idx
  on public.help_topics using gin (tags);

drop trigger if exists set_help_topics_updated_at on public.help_topics;
create trigger set_help_topics_updated_at
before update on public.help_topics
for each row execute function public.touch_updated_at();

create table if not exists public.faq_entries (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  tags text[] not null default '{}'::text[],
  is_published boolean not null default true,
  display_order integer not null default 0,
  source text null,
  created_by uuid null references auth.users(id) on delete set null,
  updated_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint faq_answer_not_empty check (length(trim(both from answer)) > 0),
  constraint faq_question_not_empty check (length(trim(both from question)) > 0)
);

create index if not exists faq_entries_updated_at_idx
  on public.faq_entries using btree (updated_at desc);

create index if not exists faq_entries_is_published_idx
  on public.faq_entries using btree (is_published, display_order);

create index if not exists faq_entries_tags_gin_idx
  on public.faq_entries using gin (tags);

drop trigger if exists set_faq_entries_updated_at on public.faq_entries;
create trigger set_faq_entries_updated_at
before update on public.faq_entries
for each row execute function public.touch_updated_at();

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid null references auth.users(id) on delete set null,
  guest_identifier text null,
  channel text not null default 'mobile_app',
  status text not null default 'OPEN' check (status in ('OPEN', 'HANDOFF_REQUESTED', 'HANDED_OFF', 'RESOLVED', 'CLOSED')),
  handoff_requested_at timestamptz null,
  handed_off_at timestamptz null,
  ticket_id uuid null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_owner_identity_chk check (user_id is not null or guest_identifier is not null)
);

create index if not exists chat_conversations_user_id_idx
  on public.chat_conversations(user_id, updated_at desc);

create index if not exists chat_conversations_guest_identifier_idx
  on public.chat_conversations(guest_identifier, updated_at desc);

create index if not exists chat_conversations_status_idx
  on public.chat_conversations(status, updated_at desc);

drop trigger if exists set_chat_conversations_updated_at on public.chat_conversations;
create trigger set_chat_conversations_updated_at
before update on public.chat_conversations
for each row execute function public.touch_updated_at();

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  message text not null,
  message_type text not null default 'text' check (message_type in ('text', 'escalation_prompt', 'escalation_confirmation', 'system_note')),
  model text null,
  token_usage jsonb not null default '{}'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint chat_message_not_empty check (length(trim(both from message)) > 0)
);

create index if not exists chat_messages_conversation_created_idx
  on public.chat_messages(conversation_id, created_at);

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique references public.chat_conversations(id) on delete cascade,
  user_id uuid null references auth.users(id) on delete set null,
  guest_identifier text null,
  status text not null default 'OPEN' check (status in ('OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED')),
  priority text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  subject text not null,
  summary text not null,
  transcript jsonb not null default '[]'::jsonb,
  assigned_to uuid null references auth.users(id) on delete set null,
  source text not null default 'chatbot',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz null,
  closed_at timestamptz null,
  constraint support_ticket_owner_identity_chk check (user_id is not null or guest_identifier is not null),
  constraint support_ticket_subject_not_empty check (length(trim(both from subject)) > 0),
  constraint support_ticket_summary_not_empty check (length(trim(both from summary)) > 0)
);

alter table public.chat_conversations
  drop constraint if exists chat_conversations_ticket_id_fkey;
alter table public.chat_conversations
  add constraint chat_conversations_ticket_id_fkey
  foreign key (ticket_id) references public.support_tickets(id) on delete set null;

create index if not exists support_tickets_status_idx
  on public.support_tickets(status, created_at desc);

create index if not exists support_tickets_user_id_idx
  on public.support_tickets(user_id, created_at desc);

create index if not exists support_tickets_guest_identifier_idx
  on public.support_tickets(guest_identifier, created_at desc);

drop trigger if exists set_support_tickets_updated_at on public.support_tickets;
create trigger set_support_tickets_updated_at
before update on public.support_tickets
for each row execute function public.touch_updated_at();

alter table public.help_topics enable row level security;
alter table public.faq_entries enable row level security;
alter table public.chat_conversations enable row level security;
alter table public.chat_messages enable row level security;
alter table public.support_tickets enable row level security;

-- Help topics / FAQ: public read when published, admin full access.
drop policy if exists "help_topics_select_published" on public.help_topics;
create policy "help_topics_select_published"
on public.help_topics
for select
to anon, authenticated
using (is_published = true or public.is_app_admin());

drop policy if exists "help_topics_admin_write" on public.help_topics;
create policy "help_topics_admin_write"
on public.help_topics
for all
to authenticated
using (public.is_app_admin())
with check (public.is_app_admin());

drop policy if exists "faq_entries_select_published" on public.faq_entries;
create policy "faq_entries_select_published"
on public.faq_entries
for select
to anon, authenticated
using (is_published = true or public.is_app_admin());

drop policy if exists "faq_entries_admin_write" on public.faq_entries;
create policy "faq_entries_admin_write"
on public.faq_entries
for all
to authenticated
using (public.is_app_admin())
with check (public.is_app_admin());

-- Conversations: user can read/write only own conversations; admin can read/write all.
drop policy if exists "chat_conversations_select_own_or_admin" on public.chat_conversations;
create policy "chat_conversations_select_own_or_admin"
on public.chat_conversations
for select
to authenticated
using (public.is_app_admin() or user_id = auth.uid());

drop policy if exists "chat_conversations_insert_own_or_admin" on public.chat_conversations;
create policy "chat_conversations_insert_own_or_admin"
on public.chat_conversations
for insert
to authenticated
with check (public.is_app_admin() or user_id = auth.uid());

drop policy if exists "chat_conversations_update_own_or_admin" on public.chat_conversations;
create policy "chat_conversations_update_own_or_admin"
on public.chat_conversations
for update
to authenticated
using (public.is_app_admin() or user_id = auth.uid())
with check (public.is_app_admin() or user_id = auth.uid());

-- Messages follow conversation ownership.
drop policy if exists "chat_messages_select_own_or_admin" on public.chat_messages;
create policy "chat_messages_select_own_or_admin"
on public.chat_messages
for select
to authenticated
using (
  public.is_app_admin()
  or exists (
    select 1
    from public.chat_conversations c
    where c.id = chat_messages.conversation_id
      and c.user_id = auth.uid()
  )
);

drop policy if exists "chat_messages_insert_own_or_admin" on public.chat_messages;
create policy "chat_messages_insert_own_or_admin"
on public.chat_messages
for insert
to authenticated
with check (
  public.is_app_admin()
  or exists (
    select 1
    from public.chat_conversations c
    where c.id = chat_messages.conversation_id
      and c.user_id = auth.uid()
  )
);

-- Tickets: users can read own tickets; only admins can update/assign/close.
drop policy if exists "support_tickets_select_own_or_admin" on public.support_tickets;
create policy "support_tickets_select_own_or_admin"
on public.support_tickets
for select
to authenticated
using (public.is_app_admin() or user_id = auth.uid());

drop policy if exists "support_tickets_insert_own_or_admin" on public.support_tickets;
create policy "support_tickets_insert_own_or_admin"
on public.support_tickets
for insert
to authenticated
with check (public.is_app_admin() or user_id = auth.uid());

drop policy if exists "support_tickets_admin_update" on public.support_tickets;
create policy "support_tickets_admin_update"
on public.support_tickets
for update
to authenticated
using (public.is_app_admin())
with check (public.is_app_admin());
