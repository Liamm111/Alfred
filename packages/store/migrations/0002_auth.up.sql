-- BLOC 03: product identity, Zoom identity and the signed stream association are three
-- separate things with three separate tables. Tokens are stored as SHA-256 hashes (product)
-- or AES-GCM envelopes in secret_refs (Zoom). Every table below carries owner_id so that
-- erase_user() (BLOC 02) verifies it is empty after an erasure.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'alfred_auth') then create role alfred_auth nologin; end if;
end $$;

-- External first-factor identity (IdP subject) -> product user. Distinct from the Zoom identity.
create table identities (
  provider   text not null,
  subject    text not null,
  owner_id   uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (provider, subject)
);

create table auth_sessions (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references users(id) on delete cascade,
  client_id      text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text
);
create index auth_sessions_owner_idx on auth_sessions (owner_id);

create table auth_codes (
  code_hash       text primary key,
  owner_id        uuid not null references users(id) on delete cascade,
  client_id       text not null,
  redirect_uri    text not null,
  code_challenge  text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  session_id      uuid references auth_sessions(id) on delete cascade
);

create table refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references auth_sessions(id) on delete cascade,
  owner_id    uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  parent_id   uuid references refresh_tokens(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz
);
create index refresh_tokens_session_idx on refresh_tokens (session_id);

create table access_tokens (
  token_hash  text primary key,
  session_id  uuid not null references auth_sessions(id) on delete cascade,
  owner_id    uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index access_tokens_session_idx on access_tokens (session_id);

-- Anti-CSRF: `state` is random, single use, bound to the product user AND product session that started the link.
create table oauth_states (
  state_hash    text primary key,
  owner_id      uuid not null references users(id) on delete cascade,
  session_id    uuid not null references auth_sessions(id) on delete cascade,
  key_id        text not null,
  verifier_ct   bytea not null,
  verifier_nonce bytea not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz
);

-- product_user <-> zoom_user_id (1:1 both ways). Tokens live in secret_refs (encrypted).
create table zoom_links (
  owner_id          uuid primary key references users(id) on delete cascade,
  zoom_user_id      text not null unique,
  zoom_account_id   text,
  scopes            text[] not null,
  access_expires_at timestamptz,
  status            text not null default 'active' check (status in ('active','needs_reauth','revoked')),
  linked_at         timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           int not null default 0
);

-- Verified (signature-checked) facts coming FROM Zoom, before any product mapping. No owner column on purpose.
create table zoom_events (
  event_id      text primary key,
  kind          text not null check (kind in ('rtms_started','rtms_stopped','app_deauthorized')),
  zoom_user_id  text not null,
  meeting_uuid  text,
  stream_id     text,
  received_at   timestamptz not null default now()
);
create index zoom_events_meeting_idx on zoom_events (meeting_uuid, zoom_user_id);

-- Ephemeral, signed association meeting_uuid/stream_id <-> product owner.
create table stream_associations (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references users(id) on delete cascade,
  zoom_user_id  text not null,
  meeting_uuid   text not null,
  stream_id      text not null,
  nonce_hash     text not null unique,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  revoked_at     timestamptz,
  unique (meeting_uuid, stream_id)
);
create index stream_associations_owner_idx on stream_associations (owner_id);

-- ---------------------------------------------------------------------------------------------
-- Privilege separation: the auth service (alfred_auth) sees auth tables, users and secrets only.
-- It has NO grant on sessions / packets / evidence; alfred_app has NO grant on any table below.
do $$
declare t text;
begin
  foreach t in array array['identities','auth_sessions','auth_codes','refresh_tokens','access_tokens','oauth_states','zoom_links','stream_associations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all to alfred_auth using (true) with check (true)', t || '_auth', t);
    execute format('create policy %I on %I for all to alfred_maintenance using (true) with check (true)', t || '_maint', t);
  end loop;
end $$;
alter table zoom_events enable row level security;
create policy zoom_events_auth on zoom_events for all to alfred_auth using (true) with check (true);
create policy zoom_events_maint on zoom_events for all to alfred_maintenance using (true) with check (true);

create policy users_auth on users for all to alfred_auth using (true) with check (true);
create policy secret_refs_auth on secret_refs for all to alfred_auth using (true) with check (true);

grant usage on schema public to alfred_auth;
grant select, insert, update, delete on identities, auth_sessions, auth_codes, refresh_tokens, access_tokens,
  oauth_states, zoom_links, zoom_events, stream_associations, secret_refs to alfred_auth;
grant select, insert, update on users to alfred_auth;
grant select, insert on jobs to alfred_auth; -- deferred Zoom revocations
create policy jobs_auth on jobs for insert to alfred_auth with check (true);
create policy jobs_auth_select on jobs for select to alfred_auth using (true);
grant select, insert, update, delete on all tables in schema public to alfred_maintenance;
grant execute on function app_current_user() to alfred_auth;

-- erase_user must count tables alfred_app can not read (auth tables), so it becomes SECURITY DEFINER.
-- Authorisation rule: the caller must be bound (app.user_id) to the very user being erased.
create or replace function erase_user(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t record; n bigint; before_counts jsonb := '{}'::jsonb; remaining bigint := 0; ok boolean;
begin
  if p_user is distinct from app_current_user() then
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
