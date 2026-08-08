#!/bin/bash
#
NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}" &&
BEMI_SLOT_NAME="${BEMI_SLOT_NAME:-bemi_local}" &&
PROPERTIES=$(<application.properties) &&
PROPERTIES="${PROPERTIES//DB_HOST/$DB_HOST}" &&
PROPERTIES="${PROPERTIES//DB_PORT/$DB_PORT}" &&
PROPERTIES="${PROPERTIES//DB_NAME/$DB_NAME}" &&
PROPERTIES="${PROPERTIES//DB_USER/$DB_USER}" &&
PROPERTIES="${PROPERTIES//DB_PASSWORD/$DB_PASSWORD}" &&
PROPERTIES="${PROPERTIES//NATS_URL/$NATS_URL}" &&
PROPERTIES="${PROPERTIES//BEMI_SLOT_NAME/$BEMI_SLOT_NAME}" &&
echo "${PROPERTIES}" > ./debezium-server/conf/application.properties &&
# reset.js drops the slot from another container; the connector offsets live
# here, and resuming from them against a recreated slot fails.
if [ "${BEMI_RESET_SLOT}" = "true" ]; then rm -f ./debezium-server/offsets.dat; fi &&
cd debezium-server && ./run.sh
