#!/bin/sh
# Local PostgreSQL for environments WITHOUT Docker (e.g. cloud sandboxes). Prefer `docker compose up -d db` elsewhere.
# usage: scripts/pg-local.sh start|stop|restart|status|kill9   (data dir: /tmp/alfred-pgdata, port 54329)
set -eu
BIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
DATA=${PGLOCAL_DATA:-/tmp/alfred-pgdata}
PORT=${PGLOCAL_PORT:-54329}
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/sh -c "$*"; else sh -c "$*"; fi; }
case "${1:-}" in
  start)
    # Sandboxes without an init process leave SIGKILLed postmasters as zombies; pg_ctl then refuses to start. Clear a stale lock.
    if [ -f "$DATA/postmaster.pid" ]; then
      PID=$(head -1 "$DATA/postmaster.pid"); ST=$(ps -o stat= -p "$PID" 2>/dev/null | tr -d ' ')
      case "$ST" in Z*|"") rm -f "$DATA/postmaster.pid" "/tmp/.s.PGSQL.$PORT.lock" "/tmp/.s.PGSQL.$PORT" ;; esac
    fi
    if [ ! -d "$DATA" ]; then
      mkdir -p "$DATA"; [ "$(id -u)" = 0 ] && chown postgres "$DATA"
      as_pg "$BIN/initdb -D $DATA -A trust -U postgres >/dev/null"
    fi
    as_pg "$BIN/pg_ctl -D $DATA status >/dev/null 2>&1 || $BIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/log -w start >/dev/null"
    as_pg "$BIN/psql -h /tmp -p $PORT -U postgres -tc \"select 1 from pg_database where datname='alfred'\" | grep -q 1 || $BIN/createdb -h /tmp -p $PORT -U postgres alfred"
    as_pg "$BIN/psql -h /tmp -p $PORT -U postgres -tc \"select 1 from pg_database where datname='alfred_test'\" | grep -q 1 || $BIN/createdb -h /tmp -p $PORT -U postgres alfred_test"
    echo "postgres://postgres@127.0.0.1:$PORT/alfred" ;;
  stop) as_pg "$BIN/pg_ctl -D $DATA -m fast -w stop" ;;
  restart) as_pg "$BIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -m immediate -w restart" ;;
  kill9) pkill -9 -u postgres -x postgres || true ;; # emulate power loss: SIGKILL postmaster and all backends
  status) as_pg "$BIN/pg_ctl -D $DATA status" ;;
  *) echo "usage: $0 start|stop|restart|kill9|status" >&2; exit 64 ;;
esac
