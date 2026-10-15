#!/bin/sh
# DB crash / restart test (Block 01): jobs committed before a hard Postgres kill (kill -9 + recovery) must survive.
# Uses the sandbox cluster from scripts/pg-local.sh. Not applicable to Docker (use `docker compose kill db && up db`).
set -eu
cd "$(dirname "$0")/.."
export DATABASE_URL_TEST=${DATABASE_URL_TEST:-postgres://postgres@127.0.0.1:54329/alfred_test}
PSQL="psql -h 127.0.0.1 -p 54329 -U postgres -d alfred_test -tA"
./scripts/pg-local.sh start >/dev/null
DATABASE_URL=$DATABASE_URL_TEST pnpm --filter @alfred/db migrate:up >/dev/null
$PSQL -c "truncate job_queue" >/dev/null
for i in 1 2 3 4 5; do $PSQL -c "insert into job_queue(type,unique_key) values ('crash.test','k$i')" >/dev/null; done
BEFORE=$($PSQL -c "select count(*) from job_queue")
# uncommitted outbox write must NOT survive
$PSQL -c "begin; insert into job_queue(type,unique_key) values ('crash.test','uncommitted'); select pg_sleep(0.1);" >/dev/null 2>&1 &
sleep 0.05
./scripts/pg-local.sh kill9 || true
wait || true
sleep 1
./scripts/pg-local.sh start >/dev/null   # crash recovery from WAL
AFTER=$($PSQL -c "select count(*) from job_queue")
GHOST=$($PSQL -c "select count(*) from job_queue where unique_key='uncommitted'")
echo "jobs before=$BEFORE after=$AFTER uncommitted_present=$GHOST"
[ "$BEFORE" = "5" ] && [ "$AFTER" = "5" ] && [ "$GHOST" = "0" ] && echo "crash-recovery: PASS" || { echo "crash-recovery: FAIL"; exit 1; }
# claim after restart still works (replay)
DATABASE_URL=$DATABASE_URL_TEST pnpm exec tsx scripts/claim-probe.mts
