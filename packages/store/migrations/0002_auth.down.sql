-- restore the SECURITY INVOKER erase_user of 0001
create or replace function erase_user(p_user uuid) returns jsonb
language plpgsql as $$
declare t record; n bigint; before_counts jsonb := '{}'::jsonb; remaining bigint := 0; ok boolean;
begin
  if current_user = 'alfred_app' and p_user is distinct from app_current_user() then
    raise exception 'erase_user: a user can only erase itself' using errcode = '42501';
  end if;
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attname = 'owner_id' and not a.attisdropped
           where s.nspname = 'public' and c.relkind = 'r' order by 1 loop
    execute format('select count(*) from %I where owner_id = $1', t.relname) into n using p_user;
    before_counts := before_counts || jsonb_build_object(t.relname, n);
  end loop;
  delete from users where id = p_user;
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attname = 'owner_id' and not a.attisdropped
           where s.nspname = 'public' and c.relkind = 'r' loop
    execute format('select count(*) from %I where owner_id = $1', t.relname) into n using p_user;
    remaining := remaining + n;
  end loop;
  ok := remaining = 0 and not exists (select 1 from users where id = p_user);
  if not ok then raise exception 'erase_user: % rows remain', remaining; end if;
  insert into deletion_receipts (user_hash, row_counts, verified)
    values (encode(sha256(convert_to(p_user::text, 'UTF8')), 'hex'), before_counts, ok);
  return jsonb_build_object('verified', ok, 'deleted', before_counts);
end $$;
revoke all on function erase_user(uuid) from public;
grant execute on function erase_user(uuid) to alfred_app, alfred_maintenance;

drop policy if exists jobs_auth on jobs;
drop policy if exists jobs_auth_select on jobs;
drop policy if exists secret_refs_auth on secret_refs;
drop policy if exists users_auth on users;
revoke all on jobs, users, secret_refs from alfred_auth;
drop table if exists stream_associations, zoom_events, zoom_links, oauth_states, access_tokens, refresh_tokens,
  auth_codes, auth_sessions, identities cascade;
-- alfred_auth is cluster-wide and intentionally kept.
