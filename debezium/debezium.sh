#!/bin/bash
# Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
# modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
#
NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}" &&
BEMI_SLOT_NAME="${BEMI_SLOT_NAME:-bemi_local}" &&
# Built here rather than templated with a bare placeholder: an unset variable
# would otherwise substitute to empty and leave a trailing comma, which
# Debezium reads as an empty pattern rather than as an error.
TABLE_EXCLUDE_LIST="public.changes" &&
if [ -n "${BEMI_EXCLUDE_TABLES:-}" ]; then
  TABLE_EXCLUDE_LIST="${TABLE_EXCLUDE_LIST},${BEMI_EXCLUDE_TABLES}"
fi &&
PROPERTIES=$(<application.properties) &&
PROPERTIES="${PROPERTIES//DB_HOST/$DB_HOST}" &&
PROPERTIES="${PROPERTIES//DB_PORT/$DB_PORT}" &&
PROPERTIES="${PROPERTIES//DB_NAME/$DB_NAME}" &&
PROPERTIES="${PROPERTIES//DB_USER/$DB_USER}" &&
PROPERTIES="${PROPERTIES//DB_PASSWORD/$DB_PASSWORD}" &&
PROPERTIES="${PROPERTIES//NATS_URL/$NATS_URL}" &&
PROPERTIES="${PROPERTIES//BEMI_SLOT_NAME/$BEMI_SLOT_NAME}" &&
PROPERTIES="${PROPERTIES//BEMI_TABLE_EXCLUDE_LIST/$TABLE_EXCLUDE_LIST}" &&
# Appended rather than templated, so the property is absent altogether when
# unset. An empty column.exclude.list is not equivalent to no list.
if [ -n "${BEMI_EXCLUDE_COLUMNS:-}" ]; then
  PROPERTIES="${PROPERTIES}
debezium.source.column.exclude.list=${BEMI_EXCLUDE_COLUMNS}"
fi &&
# Logged because every one of these silently removes audit data when wrong, and
# a typo produces a working pipeline that captures less than intended. The
# resolved values, not the raw variables - the point is to show what took
# effect.
echo "Capture filter: tables excluded = ${TABLE_EXCLUDE_LIST}; columns excluded = ${BEMI_EXCLUDE_COLUMNS:-<none>}" &&
# config/, not conf/: the dist renamed the directory in 3.x, and run.sh puts
# config on the classpath from there. Writing to the old path leaves the server
# with no configuration at all rather than failing loudly.
echo "${PROPERTIES}" > ./debezium-server/config/application.properties &&
# Fail here, by name, rather than as a bare "Permission denied" from the
# server. data/ is meant to be a volume, and a volume mounted root-owned (a
# Kubernetes PVC without fsGroup) is not writable by this image's uid 1000.
if [ ! -w ./data ]; then
  echo "debezium: /debezium/data is not writable by uid $(id -u); mount a volume there owned by, or group-writable to, gid 1000 (fsGroup: 1000)" >&2
  exit 1
fi &&
# Offsets are only valid against the slot they were taken from. When the slot is
# gone - dropped by BEMI_RESET_SLOT in stream-setup, or by hand - Debezium will
# create a new one at the current LSN, and resuming stored offsets against it
# fails. Keyed on the slot itself rather than on a marker, because nothing else
# reliably says whether this start follows a drop: a container restart, a
# recreate of Debezium alone and a new pod all look alike from in here.
SLOT_COUNT=$(PGPASSWORD="${DB_PASSWORD}" PGCONNECT_TIMEOUT=10 psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
  -tAc "select count(*) from pg_replication_slots where slot_name = '${BEMI_SLOT_NAME}'") || {
  echo "debezium: could not check for replication slot ${BEMI_SLOT_NAME}" >&2
  exit 1
} &&
if [ "${SLOT_COUNT}" = "0" ] && [ -f ./data/offsets.dat ]; then
  echo "Replication slot ${BEMI_SLOT_NAME} does not exist; discarding stored offsets" &&
  rm -f ./data/offsets.dat
fi &&
# exec so the JVM becomes PID 1 and receives SIGTERM directly. Left under bash,
# the signal is not forwarded and the container is SIGKILLed after the grace
# period, losing up to offset.flush.interval.ms of committed offsets.
cd debezium-server && exec ./run.sh
