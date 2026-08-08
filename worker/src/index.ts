// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import http from 'http';
import { AckPolicy, DeliverPolicy } from 'nats';
import { MikroORM } from '@mikro-orm/postgresql';

import { connectJetstream, buildConsumer, runIngestionLoop } from '@bemi-db/core'

import mikroOrmConfig from "../mikro-orm.config"

const NATS_URL = process.env.NATS_URL || 'nats://127.0.0.1:4222'
const HEALTH_PORT = Number(process.env.PORT) || 8081
// The fetch expires after 30s, so an idle loop still ticks on that cadence.
const STALL_TIMEOUT_MS = Number(process.env.STALL_TIMEOUT_MS) || 90_000

let lastTickAt = Date.now()

const serveHealth = () => {
  http
    .createServer((req, res) => {
      if (req.url?.split('?')[0] !== '/healthz') {
        res.writeHead(404).end()
        return
      }
      const msSinceLastFetch = Date.now() - lastTickAt
      const healthy = msSinceLastFetch < STALL_TIMEOUT_MS
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: healthy ? 'ok' : 'stalled', msSinceLastFetch }))
    })
    .listen(HEALTH_PORT)
}

;(async () => {
  serveHealth()

  const jetstreamConnection = await connectJetstream(NATS_URL);

  const consumer = await buildConsumer({
    connection: jetstreamConnection,
    stream: 'DebeziumStream',
    options: {
      durable_name: 'bemi-worker-local',
      filter_subject: 'bemi',
      ack_policy: AckPolicy.All,
      deliver_policy: DeliverPolicy.All,
    },
  });

  const jetstreamManager = await jetstreamConnection.jetstreamManager()

  const orm = await MikroORM.init(mikroOrmConfig)
  await orm.getMigrator().up();

  await runIngestionLoop({
    orm,
    consumer,
    onTick: () => { lastTickAt = Date.now() },
    // `seq` purges up to but not including it, so acked messages are released
    // and the stream only holds what is not yet durable in the audit database.
    onAcked: async (ackedStreamSequence) => {
      await jetstreamManager.streams.purge('DebeziumStream', { seq: ackedStreamSequence + 1 })
    },
  })
})()
