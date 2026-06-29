import fs from 'fs'
import { MikroORM } from '@mikro-orm/postgresql';

import { logger } from '../../core/src/logger'
import { connectJetstream, ensureDebeziumStream } from '../../core/src/nats'
import mikroOrmConfig from "../mikro-orm.config"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const main = (async () => {
  const orm = await MikroORM.init(mikroOrmConfig)
  await orm.em.getConnection().execute(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'bemi_local') THEN
        PERFORM pg_drop_replication_slot('bemi_local');
      END IF;
    END $$;
  `)
  await orm.close()

  try {
    fs.unlinkSync('./debezium-server/offsets.dat')
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      throw e
    }
  }

  // Pre-create the sink stream with bounded File storage + Limits retention
  // before Debezium starts (create-stream=false), so it never falls back to
  // the unbounded in-memory default that OOM-kills the pod. Subjects must
  // match `debezium.sink.nats-jetstream.subjects` in application.properties.
  //
  // run.sh only sleeps 1s after launching nats-server before running this, so
  // NATS may not be ready yet. Retry instead of letting the `&&` chain break —
  // a thrown error here would skip debezium.sh and silently stall ingestion
  // while the pod stays Running (run.sh `wait`s on the nats-server PID).
  const MAX_ATTEMPTS = 30
  for (let attempt = 1; ; attempt++) {
    try {
      const jetstreamConnection = await connectJetstream('nats://127.0.0.1:4222')
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
