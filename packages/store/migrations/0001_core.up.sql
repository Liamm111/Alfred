-- BLOC 02: core schema. Owner isolation is enforced twice: composite FKs (a child row can only
-- point at a parent with the SAME owner) and row-level security (alfred_app sees only its rows).
-- NOTE: raw audio / images are never stored: packets keep metadata + sha256 only (no bytea column).

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'alfred_app') then create role alfred_app nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'alfred_maintenance') then create role alfred_maintenance nologin; end if;
end $$;

create function app_current_user() returns uuid
  language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------------------------
create table users (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now()
);

create table retention_policies (
  owner_id       uuid primary key references users(id) on delete cascade,
  packets_days   int not null default 7   check (packets_days between 1 and 365),
  evidence_days  int not null default 90  check (evidence_days between 1 and 3650),
  jobs_days      int not null default 14  check (jobs_days between 1 and 365),
  updated_at     timestamptz not null default now()
);

create table sessions (
  id                       uuid primary key default gen_random_uuid(),
  owner_id                 uuid not null references users(id) on delete cascade,
  state                    text not null check (state in ('IDLE','DETECTED','PERMISSION','CONNECTING','LIVE_AUDIO','LIVE_VIDEO','LIVE_AV','DEGRADED','PAUSED','RECOVERING','FINALIZING','COMPLETED','PARTIAL','FAILED')),
  source_epoch             int  not null default 0 check (source_epoch >= 0),
  meeting_uuid             text,
  stream_id                text,
  verified_packets         int  not null default 0 check (verified_packets >= 0),
  last_audio_wall_ms       bigint,
  last_video_wall_ms       bigint,
  last_transcript_wall_ms  bigint,
  outcome                  text check (outcome in ('completed','partial','failed')),
  failure_reason           text,
  idempotency_key          text not null,
  version                  int  not null default 0,
  created_at_ms            bigint not null,
  updated_at_ms            bigint not null,
  started_at_ms            bigint,
  ended_at_ms              bigint,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (owner_id, idempotency_key),
  unique (id, owner_id),
  -- A terminal state carries an outcome, and only a terminal state does.
  check ((state in ('COMPLETED','PARTIAL','FAILED')) = (outcome is not null)),
  check (state <> 'COMPLETED' or outcome = 'completed'),
  check (state <> 'PARTIAL' or outcome = 'partial'),
  check (state <> 'FAILED' or outcome = 'failed'),
  -- A LIVE state is impossible without persisted proof of media (mirrors checkInvariants()).
  check (state not in ('LIVE_AUDIO','LIVE_VIDEO','LIVE_AV') or (verified_packets >= 1 and (last_audio_wall_ms is not null or last_video_wall_ms is not null))),
  check (state <> 'LIVE_AUDIO' or last_audio_wall_ms is not null),
  check (state <> 'LIVE_VIDEO' or last_video_wall_ms is not null),
  check (state <> 'LIVE_AV' or (last_audio_wall_ms is not null and last_video_wall_ms is not null))
);
create index sessions_owner_created_idx on sessions (owner_id, created_at desc);
-- Race-proof "one active capture per owner": two concurrent starts cannot both succeed.
create unique index sessions_one_active_per_owner on sessions (owner_id)
  where state not in ('IDLE','COMPLETED','PARTIAL','FAILED');

create table capture_sources (
  id                        uuid primary key default gen_random_uuid(),
  session_id                uuid not null,
  owner_id                  uuid not null references users(id) on delete cascade,
  kind                      text not null check (kind in ('zoom_rtms','local_capture')),
  source_epoch              int  not null check (source_epoch >= 1),
  meeting_uuid              text,
  stream_id                 text,
  status                    text not null check (status in ('pending','connected_unverified','receiving','lost','closed')),
  connected_callback_at_ms  bigint,
  first_media_at_ms         bigint,
  created_at_ms             bigint not null,
  unique (session_id, source_epoch),
  unique (id, owner_id),
  foreign key (session_id, owner_id) references sessions (id, owner_id) on delete cascade,
  -- Only real media can make a source "receiving".
  check (status <> 'receiving' or first_media_at_ms is not null)
);

create table packets (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null,
  owner_id           uuid not null references users(id) on delete cascade,
  source_epoch       int  not null check (source_epoch >= 1),
  modality           text not null check (modality in ('audio','video','transcript')),
  seq                bigint not null check (seq >= 0),
  source_ts_ms       bigint not null,
  received_wall_ms   bigint not null,
  received_mono_ms   bigint not null,
  payload_bytes      int  not null check (payload_bytes >= 0),
  payload_sha256     char(64) not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key    text not null,
  created_at         timestamptz not null default now(),
  unique (session_id, source_epoch, modality, seq),
  unique (owner_id, idempotency_key),
  unique (id, owner_id),
  foreign key (session_id, owner_id) references sessions (id, owner_id) on delete cascade
);
create index packets_session_modality_idx on packets (session_id, modality, received_wall_ms);
create index packets_created_idx on packets (created_at);

create table evidence (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null,
  owner_id       uuid not null references users(id) on delete cascade,
  kind           text not null check (kind in ('transcript_span','audio_summary','frame_observation')),
  modality       text not null check (modality in ('audio','video','transcript')),
  start_ms       bigint not null,
  end_ms         bigint not null,
  text           text not null check (length(text) <= 20000),
  confidence     numeric(4,3) not null check (confidence between 0 and 1),
  created_at_ms  bigint not null,
  created_at     timestamptz not null default now(),
  check (end_ms >= start_ms),
  unique (id, owner_id),
  foreign key (session_id, owner_id) references sessions (id, owner_id) on delete cascade
);
create index evidence_session_idx on evidence (session_id, start_ms);
create index evidence_created_idx on evidence (created_at);

create table evidence_packets (
  evidence_id  uuid not null,
  packet_id    uuid not null,
  owner_id     uuid not null references users(id) on delete cascade,
  primary key (evidence_id, packet_id),
  foreign key (evidence_id, owner_id) references evidence (id, owner_id) on delete cascade,
  foreign key (packet_id, owner_id) references packets (id, owner_id) on delete cascade
);
create index evidence_packets_packet_idx on evidence_packets (packet_id);

create table gaps (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null,
  owner_id    uuid not null references users(id) on delete cascade,
  modality    text not null check (modality in ('audio','video','transcript')),
  source_epoch int not null check (source_epoch >= 1),
  start_ms    bigint not null,
  end_ms      bigint,
  reason      text not null check (reason in ('silence','packet_expired','source_lost','paused','clock_skew','session_end','unknown')),
  check (end_ms is null or end_ms >= start_ms),
  foreign key (session_id, owner_id) references sessions (id, owner_id) on delete cascade
);
create index gaps_session_idx on gaps (session_id, modality);
create unique index gaps_one_open_per_modality on gaps (session_id, modality) where end_ms is null;

create table alerts (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null,
  owner_id       uuid not null references users(id) on delete cascade,
  severity       text not null check (severity in ('info','warning','critical')),
  code           text not null check (code in ('connected_without_media','media_silence','modality_lost','recovery_requested','recovery_failed','connect_timeout','clock_skew','session_partial','session_failed')),
  message        text not null check (length(message) between 1 and 500),
  raised_at_ms   bigint not null,
  resolved_at_ms bigint,
  foreign key (session_id, owner_id) references sessions (id, owner_id) on delete cascade
);
create index alerts_session_idx on alerts (session_id);
create unique index alerts_one_open_per_code on alerts (session_id, code) where resolved_at_ms is null;

create table assignments (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null,
  owner_id       uuid not null references users(id) on delete cascade,
  title          text not null check (length(title) between 1 and 500),
  assignee_label text,
  due_at_ms      bigint,
  status         text not null check (status in ('open','done','dismissed')),
  created_at_ms  bigint not null,
  version        int not null default 0,
  unique (id, owner_id),
  foreign key (session_id, owner_id) references sessions (id, owner_id) on delete cascade
);
create index assignments_session_idx on assignments (session_id);

create table assignment_evidence (
  assignment_id uuid not null,
  evidence_id   uuid not null,
  owner_id      uuid not null references users(id) on delete cascade,
  primary key (assignment_id, evidence_id),
  foreign key (assignment_id, owner_id) references assignments (id, owner_id) on delete cascade,
  foreign key (evidence_id, owner_id) references evidence (id, owner_id) on delete cascade
);

create table jobs (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references users(id) on delete cascade,
  type            text not null,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'queued' check (status in ('queued','running','succeeded','failed','dead')),
  attempts        int not null default 0,
  max_attempts    int not null default 5 check (max_attempts >= 1),
  run_at          timestamptz not null default now(),
  locked_by       text,
  locked_at       timestamptz,
  last_error      text,
  idempotency_key text not null,
  version         int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (owner_id, type, idempotency_key)
);
create index jobs_queue_idx on jobs (run_at) where status = 'queued';

create table outbox (
  id              bigserial primary key,
  owner_id        uuid not null references users(id) on delete cascade,
  aggregate_type  text not null,
  aggregate_id    uuid not null,
  event_type      text not null,
  payload         jsonb not null,
  dedupe_key      text not null,
  created_at      timestamptz not null default now(),
  published_at    timestamptz,
  publish_attempts int not null default 0,
  unique (owner_id, dedupe_key)
);
create index outbox_unpublished_idx on outbox (id) where published_at is null;

-- Secrets are never stored in clear: either an app-level AES-GCM envelope or a pointer to an external KMS/secret store.
create table secret_refs (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references users(id) on delete cascade,
  purpose      text not null,
  key_id       text not null,
  ciphertext   bytea,
  nonce        bytea,
  external_ref text,
  version      int not null default 0,
  created_at   timestamptz not null default now(),
  rotated_at   timestamptz,
  unique (owner_id, purpose),
  check (ciphertext is not null or external_ref is not null),
  check (ciphertext is null or (nonce is not null and length(ciphertext) > 16))
);

-- Proof that an erasure happened, without keeping any personal identifier.
create table deletion_receipts (
  id            uuid primary key default gen_random_uuid(),
  user_hash     text not null,
  row_counts    jsonb not null,
  verified      boolean not null,
  completed_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Triggers: immutability, optimistic concurrency, terminal states are final.
create function forbid_identity_change() returns trigger language plpgsql as $$
begin
  if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id then
    raise exception 'id/owner_id are immutable' using errcode = '23514';
  end if;
  return new;
end $$;

create function bump_version() returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  if tg_table_name in ('sessions','jobs') then new.updated_at := clock_timestamp(); end if;
  return new;
end $$;

create function sessions_terminal_is_final() returns trigger language plpgsql as $$
begin
  if old.state in ('COMPLETED','PARTIAL','FAILED') and
     (new.state is distinct from old.state or new.outcome is distinct from old.outcome) then
    raise exception 'terminal session state is final' using errcode = '23514';
  end if;
  if new.source_epoch < old.source_epoch then
    raise exception 'source_epoch can not decrease' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger sessions_identity  before update on sessions    for each row execute function forbid_identity_change();
create trigger sessions_version   before update on sessions    for each row execute function bump_version();
create trigger sessions_final     before update on sessions    for each row execute function sessions_terminal_is_final();
create trigger assignments_identity before update on assignments for each row execute function forbid_identity_change();
create trigger assignments_version before update on assignments for each row execute function bump_version();
create trigger jobs_identity      before update on jobs        for each row execute function forbid_identity_change();
create trigger jobs_version       before update on jobs        for each row execute function bump_version();
create trigger secret_refs_identity before update on secret_refs for each row execute function forbid_identity_change();
create trigger secret_refs_version before update on secret_refs for each row execute function bump_version();

-- Evidence must cite packets; an assignment must cite evidence (checked at COMMIT so both can be created in one tx).
create function require_children() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'evidence' and not exists (select 1 from evidence_packets where evidence_id = new.id) then
    raise exception 'evidence % has no packet', new.id using errcode = '23514';
  end if;
  if tg_table_name = 'assignments' and not exists (select 1 from assignment_evidence where assignment_id = new.id) then
    raise exception 'assignment % has no evidence', new.id using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger evidence_has_packets after insert on evidence
  deferrable initially deferred for each row execute function require_children();
create constraint trigger assignments_have_evidence after insert on assignments
  deferrable initially deferred for each row execute function require_children();

-- ---------------------------------------------------------------------------------------------
-- Row-level security. alfred_app (the API) only sees rows whose owner_id = app.user_id; an unset
-- app.user_id matches nothing (fail closed). Tables are NOT `force`d so that SECURITY DEFINER
-- maintenance functions owned by the migration role keep working; the app must never connect as
-- the table owner (asserted by tests).
do $$
declare t text;
begin
  foreach t in array array['sessions','capture_sources','packets','evidence','evidence_packets','gaps','alerts','assignments','assignment_evidence','jobs','outbox','secret_refs','retention_policies'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all to alfred_app using (owner_id = app_current_user()) with check (owner_id = app_current_user())', t || '_owner', t);
    execute format('create policy %I on %I for all to alfred_maintenance using (true) with check (true)', t || '_maint', t);
  end loop;
end $$;

alter table users enable row level security;
create policy users_self_select on users for select to alfred_app using (id = app_current_user());
create policy users_self_delete on users for delete to alfred_app using (id = app_current_user());
create policy users_maint on users for all to alfred_maintenance using (true) with check (true);
alter table deletion_receipts enable row level security;
create policy receipts_maint on deletion_receipts for all to alfred_maintenance using (true) with check (true);

grant usage on schema public to alfred_app, alfred_maintenance;
grant select, delete on users to alfred_app;
grant select, insert, update, delete on sessions, capture_sources, packets, evidence, evidence_packets, gaps, alerts,
  assignments, assignment_evidence, jobs, outbox, retention_policies to alfred_app;
-- Secrets: the app can write and replace but never read ciphertext columns in bulk through broad SELECT-ing views;
-- reads go through the same table (needed to decrypt) but only for its own rows.
grant select, insert, update, delete on secret_refs to alfred_app;
grant usage on all sequences in schema public to alfred_app, alfred_maintenance;
grant select, insert, update, delete on all tables in schema public to alfred_maintenance;
grant execute on function app_current_user() to alfred_app, alfred_maintenance;

-- ---------------------------------------------------------------------------------------------
-- Retention: minimal data lifetime. Packets (metadata) live shortest, evidence longer, finished jobs/outbox rows shortest.
create function run_retention(p_now timestamptz default now())
returns table (deleted_packets bigint, deleted_evidence bigint, deleted_jobs bigint, deleted_outbox bigint)
language plpgsql as $$
declare np bigint; ne bigint; nj bigint; nb bigint;
begin
  delete from packets p using (select u.id, coalesce(r.packets_days, 7) d from users u left join retention_policies r on r.owner_id = u.id) x
   where p.owner_id = x.id and p.created_at < p_now - make_interval(days => x.d);
  get diagnostics np = row_count;
  delete from evidence e using (select u.id, coalesce(r.evidence_days, 90) d from users u left join retention_policies r on r.owner_id = u.id) x
   where e.owner_id = x.id and e.created_at < p_now - make_interval(days => x.d);
  get diagnostics ne = row_count;
  delete from jobs j using (select u.id, coalesce(r.jobs_days, 14) d from users u left join retention_policies r on r.owner_id = u.id) x
   where j.owner_id = x.id and j.status in ('succeeded','dead') and j.updated_at < p_now - make_interval(days => x.d);
  get diagnostics nj = row_count;
  delete from outbox o where o.published_at is not null and o.published_at < p_now - interval '7 days';
  get diagnostics nb = row_count;
  return query select np, ne, nj, nb;
end $$;
revoke all on function run_retention(timestamptz) from public;
grant execute on function run_retention(timestamptz) to alfred_maintenance;

-- Verifiable erasure: counts, deletes (FK cascades), re-counts everything that carries owner_id, writes a receipt.
-- SECURITY INVOKER on purpose: alfred_app is subject to RLS and may only erase itself.
create function erase_user(p_user uuid) returns jsonb
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
grant insert on deletion_receipts to alfred_app;
create policy receipts_insert on deletion_receipts for insert to alfred_app with check (true);
