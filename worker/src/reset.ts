import fs from 'fs'
import { MikroORM } from '@mikro-orm/postgresql';

import { logger } from '../../core/src/logger'
import { connectJetstream, ensureDebeziumStream } from '../../core/src/nats'
import mikroOrmConfig from "../mikro-orm.config"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const SLOT_NAME = process.env.BEMI_SLOT_NAME || 'bemi_local'
const RESET_SLOT = process.env.BEMI_RESET_SLOT === 'true'
const NATS_URL = process.env.NATS_URL || 'nats://127.0.0.1:4222'
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

const main = (async () => {
  // Dropping the slot makes Debezium recreate it at the CURRENT LSN, so every
  // restart silently loses every change committed since the last confirmed
  // position. Keeping it means Debezium resumes exactly where it stopped; the
  // cost is WAL accumulating while the worker is down, which is recoverable.
  if (RESET_SLOT) {
    const orm = await connectOrm()
    await orm.em.getConnection().execute(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${SLOT_NAME}') THEN
          PERFORM pg_drop_replication_slot('${SLOT_NAME}');
        END IF;
      END $$;
    `)
    await orm.close()
    logger.info(`BEMI_RESET_SLOT=true - dropped replication slot "${SLOT_NAME}" and offsets`)

    try {
      fs.unlinkSync('./debezium-server/offsets.dat')
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        throw e
      }
    }
  } else {
    logger.info(`Preserving replication slot "${SLOT_NAME}" - Debezium resumes from its confirmed position`)
  }

  // Pre-create the sink stream with bounded File storage + Limits retention
  // before Debezium starts (create-stream=false), so it never falls back to
  // the unbounded in-memory default that OOM-kills the pod. Subjects must
  // match `debezium.sink.nats-jetstream.subjects` in application.properties.
  for (let attempt = 1; ; attempt++) {
    try {
      const jetstreamConnection = await connectJetstream(NATS_URL)
      await ensureDebeziumStream({
        connection: jetstreamConnection,
        stream: 'DebeziumStream',
        subjects: ['bemi', '__debezium-heartbeat.*'],
      })
      await jetstreamConnection.close()
      break
    } catch (e: any) {
      if (attempt >= MAX_ATTEMPTS) throw e
      logger.info(`NATS not ready (attempt ${attempt}/${MAX_ATTEMPTS}): ${e?.message}. Retrying in 1s...`)
      await sleep(1000)
    }
  }
})()
