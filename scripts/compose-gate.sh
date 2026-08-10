#!/usr/bin/env bash
# Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
# modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
#
# Compose regression gate. Run from the repo root, one step per invocation so
# CI reports them separately:
#
#   setup baseline downtime negative-control backpressure recovery kill-restart
#   slot-alarm capture-filter context-emit client-contract context-pairing
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

step_slot_alarm() {
  # An abandoned slot is invisible to the pipeline - it produces no records, so
  # nothing in the data path can notice it. Simulated exactly: create a slot
  # with no consumer and check the worker reports it anyway.
  # Scoped to this step. The earlier steps kill the consumer, which genuinely
  # makes bemi_local inactive for a few seconds, and those lines are correct
  # observations that would otherwise be counted here as false positives.
  local since
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  $PSQL_APP "select pg_create_logical_replication_slot('bemi_orphan','pgoutput');" >/dev/null 2>&1 \
    || fail "could not create the orphan slot"

  # Must outlast the grace period, not just a poll interval: the first
  # observation deliberately stays silent.
  local hits=0
  for _ in $(seq 1 30); do
    # grep -c, not -q: -q exits on first match and the resulting SIGPIPE trips
    # pipefail, so a match reads as a failure once the log outgrows the buffer.
    hits=$(docker compose logs --since "$since" worker 2>/dev/null | grep -c 'BEMI_SLOT_WARNING inactive.*bemi_orphan' || true)
    [ "$hits" -gt 0 ] && break
    sleep 2
  done
  [ "$hits" -gt 0 ] || {
    $PSQL_APP "select pg_drop_replication_slot('bemi_orphan');" >/dev/null 2>&1
    fail "the worker never reported the abandoned slot"
  }

  # The live slot must not be reported as inactive alongside it, or the alarm
  # fires permanently and gets muted.
  local false_positives
  false_positives=$(docker compose logs --since "$since" worker 2>/dev/null | grep -c 'BEMI_SLOT_WARNING inactive.*bemi_local' || true)

  # Read the endpoint while the orphan still exists. Dropping it first and then
  # asserting only on bemi_local would let a regression that omits the orphan
  # from the endpoint pass, under a message claiming the two agree - the stale
  # poll happens to still carry it, so the check would pass on timing.
  local reported
  reported=$(docker exec bemi-worker-1 node -e \
    "require('http').get('http://127.0.0.1:8081/healthz',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{const j=JSON.parse(b);console.log(j.replicationSlots.map(s=>s.slotName+':'+s.active).join(','))})})" \
    2>/dev/null | tr -d '[:space:]')

  $PSQL_APP "select pg_drop_replication_slot('bemi_orphan');" >/dev/null 2>&1 \
    || fail "could not drop the orphan slot"

  [ "$false_positives" = 0 ] || fail "the active slot was reported inactive $false_positives times"

  # Both facts, so an alert can be built on either the log line or a scrape
  # without the two disagreeing about what exists.
  case "$reported" in
    *bemi_local:true*) ;;
    *) fail "/healthz did not report the live slot as active: '$reported'" ;;
  esac
  case "$reported" in
    *bemi_orphan:false*) ;;
    *) fail "/healthz did not report the abandoned slot as inactive: '$reported'" ;;
  esac

  pass "abandoned slot reported in $hits log lines, no false positive on the live slot, /healthz agrees ($reported)"
}

step_capture_filter() {
  # Both knobs remove audit data when misconfigured, and a wrong one produces a
  # pipeline that runs perfectly while capturing less than intended. So each
  # assertion is paired with a control proving the pipeline still captures what
  # was not excluded - without that, "no rows appeared" passes just as happily
  # when the exclusion matched everything.
  $PSQL_APP "CREATE TABLE IF NOT EXISTS capture_excluded (id serial PRIMARY KEY, note text);" >/dev/null 2>&1 \
    || fail "could not create the excluded table"

  BEMI_EXCLUDE_TABLES=public.capture_excluded BEMI_IGNORE_FIELDS=updated_at \
    docker compose up -d --force-recreate debezium worker >/dev/null 2>&1 \
    || fail "could not restart with capture filtering enabled"
  wait_slot || fail "Debezium never reactivated the slot after reconfiguring"

  local base excluded_before
  excluded_before=$($PSQL_AUD "select count(*) from changes where \"table\"='capture_excluded';" | tr -d '[:space:]')
  base=$(count)

  # Excluded table plus control, written together so one wait covers both and
  # the control proves the pipeline was alive for the excluded write too.
  sql "INSERT INTO capture_excluded (note) VALUES ('should-not-appear');"
  sql "INSERT INTO todos (title) VALUES ('capture-control');"
  wait_count "$((base + 1))" 40 || fail "the control insert never landed; the exclusion broke capture entirely"

  local excluded_after
  excluded_after=$($PSQL_AUD "select count(*) from changes where \"table\"='capture_excluded';" | tr -d '[:space:]')
  [ "$excluded_after" = "$excluded_before" ] || fail "excluded table produced $((excluded_after - excluded_before)) change(s)"

  # Field filter. The timestamp-only update must vanish and the real one must
  # not - checked in that order against the same row, so a filter that dropped
  # everything would fail the second assertion.
  local after_control
  after_control=$(count)
  sql "UPDATE todos SET updated_at = now() WHERE title='capture-control';"
  sleep 8
  [ "$(count)" = "$after_control" ] || fail "a timestamp-only update was recorded despite BEMI_IGNORE_FIELDS"

  sql "UPDATE todos SET status='done' WHERE title='capture-control';"
  wait_count "$((after_control + 1))" 40 || fail "a real update was dropped; the field filter is too broad"

  pass "excluded table silent while control captured, timestamp-only update dropped, real update kept"
}

step_context_emit() {
  # Proves the contract the context emitter has to honour, using raw SQL rather
  # than any client library: a transactional logical message with the agreed
  # prefix, emitted in the same transaction as the writes, is stitched onto
  # them - and a rollback discards both.
  #
  # The rollback half is the one that matters. It is exactly what breaks when
  # context is emitted on a different connection from the writes: the write
  # commits independently and survives an abort that should have undone it.
  #
  # Rollback runs first and commit second, so the commit doubles as the control.
  # Asserting "the aborted row is absent" on its own would pass just as happily
  # against a dead pipeline.
  # Before the write, not after: the worker can persist it within the second,
  # and a target read afterwards already includes it - so the wait would sit
  # out its full timeout for a row that already landed.
  local target
  target=$(( $(count) + 1 ))

  docker exec -i bemi-db-1 psql -U postgres -d appdb -q >/dev/null 2>&1 <<'SQL' || fail "could not run the context transactions"
BEGIN;
SELECT pg_logical_emit_message(true, '_bemi', '{"tenantId":"ctx-aborted"}');
INSERT INTO todos (title) VALUES ('ctx-rollback');
ROLLBACK;
BEGIN;
SELECT pg_logical_emit_message(true, '_bemi', '{"tenantId":"ctx-committed"}');
INSERT INTO todos (title) VALUES ('ctx-commit');
COMMIT;
SQL

  wait_count "$target" 40 || fail "the committed write never landed; the pipeline is not capturing"

  # Give the aborted transaction the same opportunity to appear as the
  # committed one had, so its absence means something.
  sleep 5

  local committed_context aborted_rows
  committed_context=$($PSQL_AUD "select context->>'tenantId' from changes where after->>'title'='ctx-commit';" | tr -d '[:space:]')
  [ "$committed_context" = "ctx-committed" ] || fail "committed change carried context '$committed_context', expected 'ctx-committed'"

  aborted_rows=$($PSQL_AUD "select count(*) from changes where after->>'title'='ctx-rollback' or context->>'tenantId'='ctx-aborted';" | tr -d '[:space:]')
  [ "$aborted_rows" = 0 ] || fail "$aborted_rows record(s) survived a rolled back transaction"

  # Both emitters live at once. The batch-split half is unit-tested instead;
  # it cannot be forced deterministically here.
  target=$(( $(count) + 1 ))

  docker exec -i bemi-db-1 psql -U postgres -d appdb -q >/dev/null 2>&1 <<'SQL' || fail "could not run the double-context transaction"
BEGIN;
SELECT pg_logical_emit_message(true, '_bemi', '{"tenantId":"ctx-first"}');
SELECT pg_logical_emit_message(true, '_bemi', '{"tenantId":"ctx-second"}');
INSERT INTO todos (title) VALUES ('ctx-double');
COMMIT;
SQL

  wait_count "$target" 40 || fail "the double-context write never landed"

  local double_context
  double_context=$($PSQL_AUD "select context->>'tenantId' from changes where after->>'title'='ctx-double';" | tr -d '[:space:]')
  [ "$double_context" = "ctx-first" ] || fail "double-context change carried '$double_context', expected 'ctx-first'"

  pass "context stitched onto the committed change, aborted transaction left nothing behind, duplicate contexts resolved to the first"
}

step_client_contract() {
  # 0.1.0 shipped broken because nothing called the package through the driver
  # its consumers use - psql handles pg_lsn, Prisma does not.
  # Output is not discarded: this runs on the host, so `docker compose logs`
  # cannot recover it and the failure message alone says nothing useful.
  pnpm --filter @atelia/pg-change-context run prisma:generate \
    || fail "could not generate the Prisma client"
  DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/appdb" \
    pnpm --filter @atelia/pg-change-context run test:integration \
    || fail "the package does not work through a Prisma client"
  pass "package emits successfully through a real Prisma client"
}

step_context_pairing() {
  # The seam a consumer cannot test: an emit that looks right at the call site
  # but pairs with nothing downstream. Driven through the published emitter and
  # a real Prisma client, then asserted here, because only the gate can see
  # both the source and the audit database.
  pnpm --filter @atelia/pg-change-context run prisma:generate >/dev/null 2>&1 \
    || fail "could not generate the Prisma client"
  DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/appdb" \
    pnpm --filter @atelia/pg-change-context run test:pairing \
    || fail "the pairing writes did not complete"

  # Both writes of the transaction, so one context covering several changes is
  # asserted rather than assumed.
  local tx_contexts
  for _ in $(seq 1 40); do
    tx_contexts=$($PSQL_AUD "select string_agg(distinct context->>'tenantId', ',') from changes where after->>'title' in ('pair-tx-a','pair-tx-b');" | tr -d '[:space:]')
    [ "$tx_contexts" = "pair-tx" ] && break
    sleep 2
  done
  [ "$tx_contexts" = "pair-tx" ] || fail "transactional writes carried context '$tx_contexts', expected 'pair-tx'"

  local tx_rows
  tx_rows=$($PSQL_AUD "select count(*) from changes where after->>'title' in ('pair-tx-a','pair-tx-b');" | tr -d '[:space:]')
  [ "$tx_rows" = 2 ] || fail "expected 2 transactional changes, found $tx_rows"

  # The wrapped lone write - the path worth a third of tenant attribution.
  local lone
  for _ in $(seq 1 40); do
    lone=$($PSQL_AUD "select context->>'tenantId' || '/' || (context->>'requestId') from changes where after->>'title'='pair-lone';" | tr -d '[:space:]')
    [ "$lone" = "pair-lone/request-pair-lone" ] && break
    sleep 2
  done
  [ "$lone" = "pair-lone/request-pair-lone" ] || fail "lone write carried '$lone'"

  # Nothing from the aborted transaction, neither the change nor an orphan
  # context attributed to a later one.
  local aborted
  aborted=$($PSQL_AUD "select count(*) from changes where after->>'title'='pair-rollback' or context->>'tenantId'='pair-rollback';" | tr -d '[:space:]')
  [ "$aborted" = 0 ] || fail "$aborted record(s) survived the rolled back transaction"

  pass "one context covered both writes, the wrapped lone write paired with both fields intact, the rollback left nothing"
}

case "${1:-all}" in
  setup) step_setup ;;
  baseline) step_baseline ;;
  downtime) step_downtime ;;
  negative-control) step_negative_control ;;
  backpressure) step_backpressure ;;
  recovery) step_recovery ;;
  kill-restart) step_kill_restart ;;
  slot-alarm) step_slot_alarm ;;
  capture-filter) step_capture_filter ;;
  context-emit) step_context_emit ;;
  client-contract) step_client_contract ;;
  context-pairing) step_context_pairing ;;
  all)
    rc=0
    for s in setup baseline downtime negative-control backpressure recovery kill-restart slot-alarm capture-filter context-emit client-contract context-pairing; do
      printf '\n=== %s ===\n' "$s"
      "$0" "$s" || { rc=1; break; }
    done
    exit $rc
    ;;
  *) echo "unknown step: $1" >&2; exit 2 ;;
esac
