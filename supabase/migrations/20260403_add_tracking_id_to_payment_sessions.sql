alter table public.payment_sessions
  add column if not exists tracking_id varchar(8);

with numbered as (
  select
    id,
    'T' || upper(substr(md5(id::text), 1, 2)) || lpad((row_number() over (order by created_at, id))::text, 5, '0') as generated_tracking_id
  from public.payment_sessions
  where tracking_id is null
)
update public.payment_sessions ps
set tracking_id = numbered.generated_tracking_id
from numbered
where ps.id = numbered.id;

alter table public.payment_sessions
  alter column tracking_id set not null;

create unique index if not exists payment_sessions_tracking_id_uq_idx
  on public.payment_sessions (tracking_id);
