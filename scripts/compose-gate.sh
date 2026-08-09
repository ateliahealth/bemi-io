#!/usr/bin/env bash
# Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
# modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
#
# Compose regression gate. Run from the repo root, one step per invocation so
# CI reports them separately:
#
#   setup baseline downtime negative-control backpressure recovery kill-restart
#
# `all` runs them in order, which is what you want locally.
#
# Steps share state through the live system rather than shell variables, so
# each can run in its own process. The one value that cannot be recovered that
# way - the change count before the back-pressure load - is written to .gate.
set -uo pipefail

STATE_DIR=.gate
PSQL_APP="docker exec bemi-db-1 psql -U postgres -d appdb -tAc"
PSQL_AUD="docker exec bemi-db-1 psql -U postgres -d audit -tAc"

count() { $PSQL_AUD "select count(*) from changes;" 2>/dev/null | tr -d '[:space:]' || echo 0; }
sql() { docker exec bemi-db-1 psql -U postgres -d appdb -q -c "$1" >/dev/null; }
pass() { echo "PASS: $1"; exit 0; }
fail() { echo "FAIL: $1" >&2; exit 1; }

wait_count() { for _ in $(seq 1 "$2"); do [ "$(count)" -ge "$1" ] && return 0; sleep 2; done; return 1; }
wait_slot() {
  for _ in $(seq 1 60); do
    [ "$($PSQL_APP "select active from pg_replication_slots where slot_name='bemi_local'" 2>/dev/null | tr -d '[:space:]')" = t ] && return 0
    sleep 3
  done
  return 1
}

step_setup() {
  mkdir -p "$STATE_DIR"
  docker compose down -v >/dev/null 2>&1
  docker compose up -d --build >/dev/null 2>&1 || fail "compose up"
  wait_slot || fail "Debezium never activated the replication slot"
  pass "stack up on $(docker exec bemi-nats-1 nats-server --version 2>/dev/null)"
}

step_baseline() {
  sql "INSERT INTO todos (title) VALUES ('base-a'),('base-b');
       UPDATE todos SET status='done' WHERE title='base-a';
       DELETE FROM todos WHERE title='base-b';"
  wait_count 4 40 || fail "only $(count)/4 changes landed"
  local shape
  shape=$($PSQL_AUD "select string_agg(operation || ':' || (before <> '{}')::int || (after <> '{}')::int, ',' order by position) from changes;" | tr -d '[:space:]')
  [ "$shape" = "CREATE:01,CREATE:01,UPDATE:11,DELETE:10" ] || fail "unexpected before/after shape: $shape"
  pass "4 changes with correct before/after images"
}

step_downtime() {
  docker compose stop worker debezium >/dev/null 2>&1
  sql "INSERT INTO todos (title) VALUES ('down-a'),('down-b');
       UPDATE todos SET status='done' WHERE title='down-a';
       DELETE FROM todos WHERE title='down-b';"
  docker compose start worker debezium >/dev/null 2>&1
  wait_count 8 90 || fail "only $(count)/8 after restart; writes made during downtime were lost"
  pass "all 4 writes made while down landed after restart"
}

step_negative_control() {
  docker compose stop worker debezium >/dev/null 2>&1
  sql "INSERT INTO todos (title) VALUES ('lost-a'),('lost-b');
       UPDATE todos SET status='done' WHERE title='lost-a';
       DELETE FROM todos WHERE title='lost-b';"
  local before after
  before=$(count)
  BEMI_RESET_SLOT=true docker compose up -d --force-recreate stream-setup debezium worker >/dev/null 2>&1
  wait_slot >/dev/null 2>&1
  sleep 30
  after=$(count)
  [ "$after" = "$before" ] || fail "slot reset did not lose the writes ($before -> $after); the downtime test proves nothing"
  pass "writes correctly lost after slot reset ($before -> $after)"
}

step_backpressure() {
  mkdir -p "$STATE_DIR"
  docker compose stop worker >/dev/null 2>&1
  BEMI_STREAM_MAX_BYTES=4194304 docker compose up -d --force-recreate stream-setup >/dev/null 2>&1
  count > "$STATE_DIR/base"
  sql "INSERT INTO todos (title) SELECT 'bp-'||g||repeat('x',500) FROM generate_series(1,6000) g;"
  local seen=no hits retained
  for _ in $(seq 1 60); do
    # grep -c, not -q: -q exits on first match and the resulting SIGPIPE trips
    # pipefail, so a match reads as a failure once the log outgrows the buffer.
    [ "$(docker compose logs debezium 2>&1 | grep -c 10077)" -gt 0 ] && { seen=yes; break; }
    sleep 2
  done
  hits=$(docker compose logs debezium 2>&1 | grep -c 10077)
  retained=$($PSQL_APP "select pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) from pg_replication_slots where slot_name='bemi_local';" | tr -d '[:space:]')
  [ "$seen" = yes ] || fail "Debezium never rejected with 10077; the cap is not applying back-pressure (slot retained $retained)"
  pass "rejected with 10077 x$hits, replication slot holding $retained of WAL"
}

step_recovery() {
  local base target dupes
  base=$(cat "$STATE_DIR/base" 2>/dev/null) || fail "no saved count; run the backpressure step first"
  docker compose up -d --force-recreate stream-setup >/dev/null 2>&1
  docker compose up -d worker >/dev/null 2>&1
  docker compose restart debezium >/dev/null 2>&1
  target=$((base + 6000))
  wait_count "$target" 150 || fail "only $(count)/$target drained after the cap was restored"
  dupes=$($PSQL_AUD "select count(*) from (select position,\"table\",schema,database,operation from changes group by 1,2,3,4,5 having count(*)>1) d;" | tr -d '[:space:]')
  [ "$dupes" = 0 ] || fail "$dupes duplicate key groups; the replay was not idempotent"
  pass "$(count) rows = $base + 6000, 0 duplicate groups"
}

step_kill_restart() {
  local detail="" t
  for svc in worker debezium nats; do
    docker kill "bemi-$svc-1" >/dev/null 2>&1
    docker compose up -d "$svc" >/dev/null 2>&1
    for _ in $(seq 1 40); do
      [ "$(docker inspect -f '{{.State.Status}}' "bemi-$svc-1" 2>/dev/null)" = running ] && break
      sleep 2
    done
    t=$(( $(count) + 1 ))
    sql "INSERT INTO todos (title) VALUES ('ak-$svc');"
    wait_count "$t" 60 || fail "pipeline stalled after killing $svc$detail"
    detail="$detail $svc:ok"
  done
  pass "each service recovered and the pipeline resumed:$detail"
}

case "${1:-all}" in
  setup) step_setup ;;
  baseline) step_baseline ;;
  downtime) step_downtime ;;
  negative-control) step_negative_control ;;
  backpressure) step_backpressure ;;
  recovery) step_recovery ;;
  kill-restart) step_kill_restart ;;
  all)
    rc=0
    for s in setup baseline downtime negative-control backpressure recovery kill-restart; do
      printf '\n=== %s ===\n' "$s"
      "$0" "$s" || { rc=1; break; }
    done
    exit $rc
    ;;
  *) echo "unknown step: $1" >&2; exit 2 ;;
esac
