-- SYNTHETIC test data only (no real person, meeting, token or media). Refuses to run unless
-- explicitly allowed:   psql -c "set alfred.allow_seed = 'on'" -f db/seed/synthetic_seed.sql  (same session)
do $$ begin
  if coalesce(current_setting('alfred.allow_seed', true), 'off') <> 'on' then
    raise exception 'seed refused: set alfred.allow_seed = on (test databases only)';
  end if;
end $$;

insert into users (id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

insert into sessions (id, owner_id, state, source_epoch, meeting_uuid, stream_id, verified_packets, last_audio_wall_ms, idempotency_key, created_at_ms, updated_at_ms, started_at_ms, outcome, ended_at_ms)
values
  ('a0000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','LIVE_AUDIO',1,'synthetic-meeting-A','synthetic-stream-A',2,1700000001000,'seed-a-1',1700000000000,1700000001000,1700000000100,null,null),
  ('b0000000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','COMPLETED',1,'synthetic-meeting-B','synthetic-stream-B',1,1700000001000,'seed-b-1',1700000000000,1700000002000,1700000000100,'completed',1700000002000);

insert into packets (id, session_id, owner_id, source_epoch, modality, seq, source_ts_ms, received_wall_ms, received_mono_ms, payload_bytes, payload_sha256, idempotency_key)
values
  ('a1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'audio',0,1700000000960,1700000001000,101000,320,repeat('a',64),'seed-a-p0'),
  ('a1000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'audio',1,1700000001960,1700000002000,102000,320,repeat('b',64),'seed-a-p1');
