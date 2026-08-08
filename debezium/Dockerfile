FROM debian:bookworm-slim AS fetch

ARG DEBEZIUM_VERSION=2.5.0.Final

RUN apt-get update && \
  apt-get install -y --no-install-recommends curl ca-certificates && \
  rm -rf /var/lib/apt/lists/* && \
  curl -fsSLO https://repo1.maven.org/maven2/io/debezium/debezium-server-dist/${DEBEZIUM_VERSION}/debezium-server-dist-${DEBEZIUM_VERSION}.tar.gz && \
  tar -xf debezium-server-dist-${DEBEZIUM_VERSION}.tar.gz && \
  rm debezium-server-dist-${DEBEZIUM_VERSION}.tar.gz

################################################################################

FROM eclipse-temurin:17-jre-jammy

WORKDIR /debezium

COPY --from=fetch /debezium-server ./debezium-server
COPY debezium/application.properties ./
COPY debezium/debezium.sh ./

# debezium.sh rewrites conf/application.properties and the server persists
# offsets.dat, both under /debezium, so the runtime user must own it.
RUN useradd --create-home --uid 1000 debezium && chown -R debezium:debezium /debezium

USER debezium

CMD ["./debezium.sh"]
