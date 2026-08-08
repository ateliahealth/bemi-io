// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import { MikroORM } from '@mikro-orm/postgresql';

import { logger } from '../../core/src/logger'
import { connectJetstream, ensureDebeziumStream } from '../../core/src/nats'
import mikroOrmConfig from "../mikro-orm.config"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const SLOT_NAME = process.env.BEMI_SLOT_NAME || 'bemi_local'
const RESET_SLOT = process.env.BEMI_RESET_SLOT === 'true'
const NATS_URL = process.env.NATS_URL || 'nats://127.0.0.1:4222'
// Bounds how far Debezium can publish ahead of the worker, so it is the ceiling
// on what a lost stream costs. Must fit the volume backing the JetStream store.
const STREAM_MAX_BYTES = Number(process.env.BEMI_STREAM_MAX_BYTES) || undefined
const MAX_ATTEMPTS = 30

const connectOrm = async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await MikroORM.init(mikroOrmConfig)
    } catch (e: any) {
      if (attempt >= MAX_ATTEMPTS) throw e
      logger.info(`Database not ready (attempt ${attempt}/${MAX_ATTEMPTS}): ${e?.message}. Retrying in 1s...`)
      await sleep(1000)
    }
  }
}

;(async () => {
  // Dropping the slot makes Debezium recreate it at the CURRENT LSN, so every
  // restart silently loses every change committed since the last confirmed
  // position. Keeping it means Debezium resumes exactly where it stopped; the
  // cost is WAL accumulating while the worker is down, which is recoverable.
  if (RESET_SLOT) {
    const orm = await connectOrm()
    // Selecting from pg_replication_slots makes this a no-op when the slot is
    // absent, so no DO block is needed and the name can be a bound parameter.
    await orm.em
      .getConnection()
      .execute('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = ?', [
        SLOT_NAME,
      ])
    await orm.close()
    // Debezium's offsets.dat lives in the debezium container, not this one;
    // debezium.sh removes it under the same flag before starting the server.
    logger.info(`BEMI_RESET_SLOT=true - dropped replication slot "${SLOT_NAME}"`)
  } else {
    logger.info(`Preserving replication slot "${SLOT_NAME}" - Debezium resumes from its confirmed position`)
  }

  // Pre-create the sink stream with bounded File storage + Limits retention
  // before Debezium starts (create-stream=false), so it never falls back to
  // the unbounded in-memory default that OOM-kills the pod. Subjects must
  // match `debezium.sink.nats-jetstream.subjects` in application.properties.
  for (let attempt = 1; ; attempt++) {
    // Closed in `finally`: a connection left open by a failed attempt keeps the
    // event loop alive, so this process never exits and every service gated on
    // it completing never starts.
    let jetstreamConnection
    try {
      jetstreamConnection = await connectJetstream(NATS_URL)
      await ensureDebeziumStream({
        connection: jetstreamConnection,
        stream: 'DebeziumStream',
        subjects: ['bemi', '__debezium-heartbeat.*'],
        maxBytes: STREAM_MAX_BYTES,
      })
      break
    } catch (e: any) {
      if (attempt >= MAX_ATTEMPTS) throw e
      logger.info(`NATS not ready (attempt ${attempt}/${MAX_ATTEMPTS}): ${e?.message}. Retrying in 1s...`)
      await sleep(1000)
    } finally {
      await jetstreamConnection?.close()
    }
  }
})().catch((e) => {
  logger.info(`Reset failed: ${e?.stack || e}`)
  process.exit(1)
})
