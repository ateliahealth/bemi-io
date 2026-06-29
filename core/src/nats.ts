import {
  connect,
  ConsumerConfig,
  DiscardPolicy,
  JSONCodec,
  NatsConnection,
  RetentionPolicy,
  StorageType,
} from 'nats'

import { logger } from './logger'

const JSON_CODEC = JSONCodec()

// Hard cap on the on-disk stream size; oldest messages are discarded past it.
const DEFAULT_STREAM_MAX_BYTES = 1024 * 1024 * 1024 // 1 GiB
// Retain at most this much history. The worker normally acks within seconds,
// so this only matters as a buffer if the worker is briefly down — and it
// bounds how much the stream can grow regardless of consumer progress.
const DEFAULT_STREAM_MAX_AGE_NS = 6 * 60 * 60 * 1e9 // 6 hours, in nanoseconds

export const connectJetstream = (host: string) => {
  return connect({ servers: host })
}

/**
 * Pre-create the Debezium sink stream with bounded, file-backed retention.
 *
 * Debezium's nats-jetstream sink (`create-stream=true`) creates the stream
 * with **Memory storage, Limits retention and no size/age cap**. That means
 * every CDC change is held in RAM forever (acking does not free it under
 * Limits retention), so NATS' memory grows until the pod is OOM-killed
 * (~every 2-3 days). The only thing that reset it was the crash itself
 * wiping ephemeral /tmp.
 *
 * Fix: keep Limits retention — the worker consumes with `AckPolicy.All`,
 * which WorkQueue retention rejects ("workqueue stream requires explicit
 * ack") — but move the data to **File storage** (off-heap) and bound it with
 * `max_bytes` + `max_age` + DiscardOld. File storage keeps RAM to a small
 * index, and the size/age caps stop unbounded growth. The audit `changes`
 * table is the durable record; the stream is only a transport buffer.
 *
 * Recreated on every boot (alongside the replication-slot reset) so the
 * desired config is always applied and any stale/bloated stream is cleared.
 */
export const ensureDebeziumStream = async ({
  connection,
  stream,
  subjects,
  maxBytes = DEFAULT_STREAM_MAX_BYTES,
  maxAgeNs = DEFAULT_STREAM_MAX_AGE_NS,
}: {
  connection: NatsConnection
  stream: string
  subjects: string[]
  maxBytes?: number
  maxAgeNs?: number
}) => {
  const jetstreamManager = await connection.jetstreamManager()

  try {
    await jetstreamManager.streams.info(stream)
    logger.info(`Deleting existing stream "${stream}" to reset retention config...`)
    await jetstreamManager.streams.delete(stream)
  } catch (e) {
    if (e instanceof Error && e.message !== 'stream not found') throw e
  }

  logger.info(
    `Creating stream "${stream}" (File storage, Limits retention, max_bytes=${maxBytes}, max_age=${maxAgeNs}ns)...`,
  )
  await jetstreamManager.streams.add({
    name: stream,
    subjects,
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_bytes: maxBytes,
    max_age: maxAgeNs,
    num_replicas: 1,
  })
}

export const buildConsumer = async ({
  connection,
  stream,
  options,
}: {
  connection: NatsConnection
  stream: string
  options: Partial<ConsumerConfig>
}) => {
  const jetstream = connection.jetstream()
  const jetstreamManager = await connection.jetstreamManager()
  let consumer

  try {
    consumer = await jetstream.consumers.get(stream, options.durable_name)
    const { config } = await consumer.info()
    const hasDifferentValue = Object.keys(options).some((key) => {
      const keyAsOptionsKeyType = key as keyof typeof options
      return options[keyAsOptionsKeyType] !== config[keyAsOptionsKeyType]
    })
    if (hasDifferentValue && options.durable_name) {
      logger.info('Updating consumer...')
      await jetstreamManager.consumers.update(stream, options.durable_name, options)
    }
  } catch (e) {
    if (e instanceof Error && e.message !== 'consumer not found') throw e
    logger.info('Creating consumer...')
    await jetstreamManager.consumers.add(stream, options)
    consumer = await jetstream.consumers.get(stream, options.durable_name)
  }

  return consumer
}

export const decodeData = (data: Uint8Array) => {
  return JSON_CODEC.decode(data)
}

export const encodeData = (data: Uint8Array) => {
  return JSON_CODEC.encode(data)
}
