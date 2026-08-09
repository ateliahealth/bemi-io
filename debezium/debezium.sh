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
# reset.js drops the slot from another container; the connector offsets live
# here, and resuming from them against a recreated slot fails. The marker
# keeps this to once per container: stream-setup is one-shot, so on an
# in-place restart the slot still exists and wiping offsets would replay it.
if [ "${BEMI_RESET_SLOT}" = "true" ] && [ ! -f ./debezium-server/.reset-applied ]; then
  rm -f ./debezium-server/offsets.dat && touch ./debezium-server/.reset-applied
fi &&
# exec so the JVM becomes PID 1 and receives SIGTERM directly. Left under bash,
# the signal is not forwarded and the container is SIGKILLed after the grace
# period, losing up to offset.flush.interval.ms of committed offsets.
cd debezium-server && exec ./run.sh
