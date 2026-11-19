CREATE OR REPLACE FUNCTION public.prevent_role_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
declare
  actor_role text;
begin
  if new.role is distinct from old.role then
    select lower(coalesce(role, ''))
    into actor_role
    from public.users
    where id = auth.uid();

    if actor_role not in ('admin', 'superadmin') then
      raise exception 'Role changes are not allowed';
    end if;

    if actor_role <> 'superadmin'
       and (lower(coalesce(new.role, '')) in ('admin', 'superadmin', 'super_admin')
            or lower(coalesce(old.role, '')) in ('admin', 'superadmin', 'super_admin')) then
      raise exception 'Only a superadmin can grant or remove admin roles' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$function$;
