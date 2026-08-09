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

WORKDIR /debezium

COPY --from=fetch /debezium-server ./debezium-server
COPY debezium/application.properties ./
COPY debezium/debezium.sh ./

# debezium.sh rewrites conf/application.properties and the server persists
# offsets.dat, both under /debezium, so the runtime user must own it.
RUN useradd --create-home --uid 1000 debezium && chown -R debezium:debezium /debezium

USER debezium

CMD ["./debezium.sh"]
