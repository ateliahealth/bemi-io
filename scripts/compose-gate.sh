#!/usr/bin/env bash
# Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
# modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
# Compose regression gate for bemi-io. Run from the repo root.
set -uo pipefail

PSQL_APP="docker exec bemi-db-1 psql -U postgres -d appdb -tAc"
PSQL_AUD="docker exec bemi-db-1 psql -U postgres -d audit -tAc"
RESULTS=""
fail=0

note() { printf '\n### %s\n' "$1"; }
record() {
  RESULTS="${RESULTS}$1|$2|$3"$'\n'
  [ "$2" = PASS ] || fail=1
}
count() { $PSQL_AUD "select count(*) from changes;" 2>/dev/null | tr -d '[:space:]' || echo 0; }
wait_count() { # $1 target, $2 tries
  for _ in $(seq 1 "$2"); do [ "$(count)" -ge "$1" ] && return 0; sleep 2; done
  return 1
}
wait_slot() {
  for _ in $(seq 1 60); do
    [ "$($PSQL_APP "select active from pg_replication_slots where slot_name='bemi_local'" 2>/dev/null | tr -d '[:space:]')" = t ] && return 0
    sleep 3
  done
  return 1
}

note "SETUP: clean slate + build"
docker compose down -v >/dev/null 2>&1
docker compose up -d --build >/dev/null 2>&1 || { echo "compose up failed"; exit 1; }
wait_slot || { echo "debezium never activated the slot"; exit 1; }
echo "stack up, slot active"

note "TEST 1 - baseline"
docker exec bemi-db-1 psql -U postgres -d appdb -q -c \
  "INSERT INTO todos (title) VALUES ('base-a'),('base-b');
   UPDATE todos SET status='done' WHERE title='base-a';
   DELETE FROM todos WHERE title='base-b';" >/dev/null
if wait_count 4 40; then
  shape=$($PSQL_AUD "select string_agg(operation || ':' || (before <> '{}')::int || (after <> '{}')::int, ',' order by position) from changes;" | tr -d '[:space:]')
  [ "$shape" = "CREATE:01,CREATE:01,UPDATE:11,DELETE:10" ] \
    && record "1 baseline" PASS "4 changes, shape $shape" \
    || record "1 baseline" FAIL "unexpected shape: $shape"
else
  record "1 baseline" FAIL "only $(count)/4 landed"
fi

note "TEST 2 - downtime recovery"
docker compose stop worker debezium >/dev/null 2>&1
docker exec bemi-db-1 psql -U postgres -d appdb -q -c \
  "INSERT INTO todos (title) VALUES ('down-a'),('down-b');
   UPDATE todos SET status='done' WHERE title='down-a';
   DELETE FROM todos WHERE title='down-b';" >/dev/null
docker compose start worker debezium >/dev/null 2>&1
wait_count 8 90 \
  && record "2 downtime" PASS "all 4 landed after restart (total $(count))" \
  || record "2 downtime" FAIL "only $(count)/8"

note "TEST 3 - negative control (BEMI_RESET_SLOT=true)"
docker compose stop worker debezium >/dev/null 2>&1
docker exec bemi-db-1 psql -U postgres -d appdb -q -c \
  "INSERT INTO todos (title) VALUES ('lost-a'),('lost-b');
   UPDATE todos SET status='done' WHERE title='lost-a';
   DELETE FROM todos WHERE title='lost-b';" >/dev/null
before=$(count)
BEMI_RESET_SLOT=true docker compose up -d --force-recreate stream-setup debezium worker >/dev/null 2>&1
wait_slot >/dev/null 2>&1
sleep 30
after=$(count)
[ "$after" = "$before" ] \
  && record "3 negative control" PASS "changes correctly lost ($before -> $after)" \
  || record "3 negative control" FAIL "control has no teeth ($before -> $after)"

note "TEST 4 - back-pressure at 4 MiB"
docker compose stop worker >/dev/null 2>&1
BEMI_STREAM_MAX_BYTES=4194304 docker compose up -d --force-recreate stream-setup >/dev/null 2>&1
base=$(count)
docker exec bemi-db-1 psql -U postgres -d appdb -q -c \
  "INSERT INTO todos (title) SELECT 'bp-'||g||repeat('x',500) FROM generate_series(1,6000) g;" >/dev/null
seen=no
for _ in $(seq 1 60); do
  # grep -c, not -q: -q exits on the first match, and the resulting SIGPIPE on
  # `docker compose logs` trips pipefail, so a match reads as a failure.
  [ "$(docker compose logs debezium 2>&1 | grep -c 10077)" -gt 0 ] && { seen=yes; break; }
  sleep 2
done
retained=$($PSQL_APP "select pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) from pg_replication_slots where slot_name='bemi_local';" | tr -d '[:space:]')
hits=$(docker compose logs debezium 2>&1 | grep -c 10077)
[ "$seen" = yes ] \
  && record "4 back-pressure" PASS "10077 x$hits, slot holding $retained WAL" \
  || record "4 back-pressure" FAIL "no 10077 seen; slot retained $retained"

note "TEST 4b - recovery at 1 GiB"
docker compose up -d --force-recreate stream-setup >/dev/null 2>&1
docker compose up -d worker >/dev/null 2>&1
docker compose restart debezium >/dev/null 2>&1
target=$((base + 6000))
if wait_count "$target" 150; then
  dupes=$($PSQL_AUD "select count(*) from (select position,\"table\",schema,database,operation from changes group by 1,2,3,4,5 having count(*)>1) d;" | tr -d '[:space:]')
  [ "$dupes" = 0 ] \
    && record "4b recovery" PASS "$(count) rows = $base + 6000, 0 duplicate groups" \
    || record "4b recovery" FAIL "$dupes duplicate key groups"
else
  record "4b recovery" FAIL "only $(count)/$target after cap restored"
fi

note "TEST 5 - per-service kill + restart"
allok=yes; detail=""
for svc in worker debezium nats; do
  docker kill "bemi-$svc-1" >/dev/null 2>&1
  docker compose up -d "$svc" >/dev/null 2>&1
  for _ in $(seq 1 40); do
    [ "$(docker inspect -f '{{.State.Status}}' "bemi-$svc-1" 2>/dev/null)" = running ] && break
    sleep 2
  done
  t=$(( $(count) + 1 ))
  docker exec bemi-db-1 psql -U postgres -d appdb -q -c "INSERT INTO todos (title) VALUES ('ak-$svc');" >/dev/null
  if wait_count "$t" 60; then detail="$detail $svc:ok"; else detail="$detail $svc:STALLED"; allok=no; fi
done
[ "$allok" = yes ] \
  && record "5 kill+restart" PASS "recovered and propagated:$detail" \
  || record "5 kill+restart" FAIL "$detail"

printf '\n\n===================== GATE RESULTS =====================\n'
printf '%s' "$RESULTS" | while IFS='|' read -r t r d; do printf '%-22s %-5s %s\n' "$t" "$r" "$d"; done
printf '========================================================\n'
printf 'nats:    %s\n' "$(docker exec bemi-nats-1 nats-server --version 2>/dev/null)"
printf 'overall: %s\n' "$([ $fail -eq 0 ] && echo ALL PASS || echo FAILURES PRESENT)"
exit $fail
