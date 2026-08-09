// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import http from 'http'
import { AckPolicy, DeliverPolicy, jetstreamManager } from '@nats-io/jetstream'
import { MikroORM } from '@mikro-orm/postgresql'

import {
  connectJetstream,
  buildConsumer,
  runIngestionLoop,
  readReplicationSlots,
  observeSlots,
  logSlotWarnings,
  logger,
  type ReplicationSlotState,
  type SlotMonitorState,
} from '@bemi-db/core'

import mikroOrmConfig from '../mikro-orm.config'

const NATS_URL = process.env.NATS_URL || 'nats://127.0.0.1:4222'
const HEALTH_PORT = Number(process.env.PORT) || 8081
// The fetch expires after 30s, so an idle loop still ticks on that cadence.
const STALL_TIMEOUT_MS = Number(process.env.STALL_TIMEOUT_MS) || 90_000
const SLOT_POLL_INTERVAL_MS = Number(process.env.BEMI_SLOT_POLL_INTERVAL_MS) || 60_000
// Generous by default: a slot legitimately holds WAL whenever the worker is
// behind, so a tight threshold alerts on ordinary backlog. The failure this
// exists to catch grows without bound, so it crosses any threshold eventually
// and the only cost of a high one is noticing later.
const SLOT_RETENTION_WARN_BYTES = Number(process.env.BEMI_SLOT_RETENTION_WARN_BYTES) || 10 * 1024 * 1024 * 1024
// Long enough to sit out an ordinary restart of whatever consumes the slot,
// short enough that a genuinely abandoned one is reported the same day. The
// condition this catches takes days to become expensive, so erring long costs
// little and erring short costs the alarm's credibility.
const SLOT_INACTIVE_GRACE_MS = Number(process.env.BEMI_SLOT_INACTIVE_GRACE_MS) || 15 * 60 * 1000

let lastTickAt = Date.now()
let lastSlots: ReplicationSlotState[] = []
let lastSlotReadAt: number | undefined = undefined
// Survives only as long as the process. A restart restarts the grace period,
// which is the safe direction: it delays a warning rather than inventing one.
let slotMonitorState: SlotMonitorState = {}

const serveHealth = () => {
  http
    .createServer((req, res) => {
      if (req.url?.split('?')[0] !== '/healthz') {
        res.writeHead(404).end()
        return
      }
      const msSinceLastFetch = Date.now() - lastTickAt
      const healthy = msSinceLastFetch < STALL_TIMEOUT_MS
      // Slot state is reported but deliberately does not affect the status
      // code. This endpoint is a liveness probe: returning 503 restarts the
      // pod, and restarting does nothing about a slot no consumer owns - it
      // would trade a disk problem for a crash loop that makes the backlog
      // worse. Slot trouble is for alerting, not for the scheduler.
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: healthy ? 'ok' : 'stalled',
          msSinceLastFetch,
          replicationSlots: lastSlots,
          slotsReadAt: lastSlotReadAt === undefined ? null : new Date(lastSlotReadAt).toISOString(),
        }),
      )
    })
    .listen(HEALTH_PORT)
}

// Runs beside the ingestion loop rather than inside it, because the condition
// it looks for is one where the loop is healthy and processing nothing: an
// abandoned slot leaves no trace in the stream, so a check driven by traffic
// cannot see it.
const pollReplicationSlots = (orm: MikroORM) => {
  const poll = async () => {
    try {
      lastSlots = await readReplicationSlots(orm)
      lastSlotReadAt = Date.now()
      const { warnings, state } = observeSlots({
        slots: lastSlots,
        previousState: slotMonitorState,
        now: lastSlotReadAt,
        retentionWarnBytes: SLOT_RETENTION_WARN_BYTES,
        inactiveGraceMs: SLOT_INACTIVE_GRACE_MS,
      })
      slotMonitorState = state
      logSlotWarnings(warnings)
    } catch (e: any) {
      // Never fatal: this is observability, and a pipeline that stops
      // capturing changes because it could not measure a slot is strictly
      // worse than one that captures them unmeasured.
      logger.info(`Failed to read replication slots: ${e?.message}`)
    }
  }

  void poll()
  // unref so this timer alone never holds the process open.
  setInterval(poll, SLOT_POLL_INTERVAL_MS).unref()
}

;(async () => {
  serveHealth()

  const jetstreamConnection = await connectJetstream(NATS_URL)

  const consumer = await buildConsumer({
    connection: jetstreamConnection,
    stream: 'DebeziumStream',
    options: {
      durable_name: 'bemi-worker-local',
      filter_subject: 'bemi',
      ack_policy: AckPolicy.All,
      deliver_policy: DeliverPolicy.All,
    },
  })

  const manager = await jetstreamManager(jetstreamConnection)

  const orm = await MikroORM.init(mikroOrmConfig)
  await orm.migrator.up()

  pollReplicationSlots(orm)

  await runIngestionLoop({
    orm,
    consumer,
    onTick: () => {
      lastTickAt = Date.now()
    },
    // `seq` purges up to but not including it, so acked messages are released
    // and the stream only holds what is not yet durable in the audit database.
    onAcked: async (ackedStreamSequence) => {
      await manager.streams.purge('DebeziumStream', { seq: ackedStreamSequence + 1 })
    },
  })
})()
