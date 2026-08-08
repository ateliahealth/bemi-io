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

// Hard cap on the on-disk stream size. Past it, DiscardPolicy.New rejects the
// publish rather than dropping anything already accepted.
const DEFAULT_STREAM_MAX_BYTES = 1024 * 1024 * 1024 // 1 GiB
// No age limit: under Limits retention, eviction ignores consumer progress, so
// any max_age silently drops un-acked messages once the worker is down that
// long. Growth is bounded by max_bytes instead.
const DEFAULT_STREAM_MAX_AGE_NS = 0

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
 * `max_bytes`. File storage keeps RAM to a small index.
 *
 * Discard policy is **New**, not Old. Under Limits retention eviction ignores
 * consumer progress, so DiscardOld silently drops changes the worker has not
 * persisted yet — and Debezium has already advanced the replication slot past
 * them, making them unrecoverable. DiscardNew instead rejects the publish, so
 * Debezium fails the batch, does not commit its offset, and the change stays
 * in the source WAL until the worker catches up. That trades silent data loss
 * for visible back-pressure and WAL growth, which needs alerting on write
 * staleness to be safe.
 *
 * Reused across boots so undelivered messages survive a restart; the retention
 * config is re-applied in place on every boot.
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

  const config = {
    name: stream,
    subjects,
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.New,
    max_bytes: maxBytes,
    max_age: maxAgeNs,
    num_replicas: 1,
  }

  let existing
  try {
    existing = await jetstreamManager.streams.info(stream)
  } catch (e) {
    if (e instanceof Error && e.message !== 'stream not found') throw e
  }

  if (!existing) {
    logger.info(`Creating stream "${stream}" (File storage, max_bytes=${maxBytes}, max_age=${maxAgeNs}ns)...`)
    await jetstreamManager.streams.add(config)
    return
  }

  // Deleting the stream discards every message Debezium already published but
  // the worker has not persisted yet - and the replication slot has advanced
  // past them, so they are unrecoverable. Update in place instead. Storage and
  // retention are rejected by the server on an existing stream, so they can
  // only be changed by recreating it.
  const immutableChanged =
    existing.config.storage !== config.storage || existing.config.retention !== config.retention

  if (immutableChanged) {
    if (existing.state.messages > 0) {
      throw new Error(
        `Stream "${stream}" needs recreating (storage=${existing.config.storage}, retention=${existing.config.retention}) ` +
          `but holds ${existing.state.messages} undelivered messages. Refusing to discard them; drain or delete it manually.`,
      )
    }
    logger.info(`Recreating empty stream "${stream}" as ${config.storage}/${config.retention}...`)
    await jetstreamManager.streams.delete(stream)
    await jetstreamManager.streams.add(config)
    return
  }

  // `name`, `storage` and `retention` are not part of StreamUpdateConfig; the
  // client merges whatever it is given into the existing config and the server
  // rejects the request if they differ.
  const { name: _name, storage: _storage, retention: _retention, ...updatable } = config

  logger.info(`Reusing stream "${stream}" (${existing.state.messages} pending); applying retention config...`)
  await jetstreamManager.streams.update(stream, updatable)
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
