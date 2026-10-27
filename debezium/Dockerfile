# Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
# modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
FROM debian:bookworm-slim AS fetch

ARG DEBEZIUM_VERSION=3.6.1.Final

RUN apt-get update && \
  apt-get install -y --no-install-recommends curl ca-certificates && \
  rm -rf /var/lib/apt/lists/* && \
  curl -fsSLO https://repo1.maven.org/maven2/io/debezium/debezium-server-dist/${DEBEZIUM_VERSION}/debezium-server-dist-${DEBEZIUM_VERSION}.tar.gz && \
  tar -xf debezium-server-dist-${DEBEZIUM_VERSION}.tar.gz && \
  rm debezium-server-dist-${DEBEZIUM_VERSION}.tar.gz

################################################################################

# Debezium 3.x is compiled for Java 21: its classes are class-file version 65,
# which a 17 JRE refuses to load.
FROM eclipse-temurin:21-jre-jammy

# debezium.sh checks the replication slot exists before trusting stored offsets.
RUN apt-get update && \
  apt-get install -y --no-install-recommends postgresql-client && \
  rm -rf /var/lib/apt/lists/*

WORKDIR /debezium

COPY --from=fetch /debezium-server ./debezium-server
COPY debezium/application.properties ./
COPY debezium/debezium.sh ./

# debezium.sh rewrites config/application.properties under /debezium, so the
# runtime user must own it. data/ holds the connector offsets and is meant to be
# a mounted volume: on the container's own filesystem they are lost on every
# restart, and Debezium then replays from the slot's last confirmed commit.
RUN useradd --create-home --uid 1000 debezium && mkdir -p /debezium/data && chown -R debezium:debezium /debezium

USER debezium

CMD ["./debezium.sh"]
