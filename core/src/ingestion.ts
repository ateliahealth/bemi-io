import { MikroORM, RequiredEntityData } from '@mikro-orm/postgresql'
import { Consumer, JsMsg } from 'nats'

import { logger } from './logger'
import { Change } from './entities/Change'
import { FetchedRecord } from './fetched-record'
import { FetchedRecordBuffer } from './fetched-record-buffer'
import { stitchFetchedRecords } from './stitching'
import { createHash } from 'crypto'

const INSERT_INTERVAL_MS = 1000 // 1 second to avoid overwhelming the database
const FETCH_EXPIRES_MS = 30_000 // 30 seconds, default

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const chunk = <T>(array: T[], size: number): T[][] =>
  [...Array(Math.ceil(array.length / size))].map((_, i) => array.slice(size * i, size + size * i))

const persistFetchedRecords = async ({
  orm,
  fetchedRecords,
  insertBatchSize,
}: {
  orm: MikroORM
  fetchedRecords: FetchedRecord[]
  insertBatchSize: number
}) => {
  logger.info(`Persisting ${fetchedRecords.length} change message(s)...`)
  const batches = chunk(fetchedRecords, insertBatchSize)

  for (const fetchedRecs of batches) {
    const changesAttributes = fetchedRecs.map(({ changeAttributes }) => ({
      ...changeAttributes,
      hash: createHash('sha256').update(JSON.stringify(changeAttributes)).digest('hex'),
    }))
    const queryBuilder = orm.em.createQueryBuilder(Change).insert(changesAttributes).onConflict().ignore()
    await queryBuilder.execute()
  }
}

const fetchNatsMessages = async ({
  consumer,
  fetchBatchSize,
  lastStreamSequence,
}: {
  consumer: Consumer
  fetchBatchSize: number
  lastStreamSequence: number | null
}) => {
  const natsMessageBySequence: { [sequence: number]: JsMsg } = {}
  let pendingMessageCount = 0

  const iterator = await consumer.fetch({ max_messages: fetchBatchSize, expires: FETCH_EXPIRES_MS })

  for await (const natsMessage of iterator) {
    const { streamSequence, pending } = natsMessage.info
    logger.debug(`Fetched stream sequence: ${streamSequence}, pending: ${pending}`)

    pendingMessageCount = pending

    // Accumulate the batch
    if (!lastStreamSequence || lastStreamSequence < streamSequence) {
      natsMessageBySequence[streamSequence] = natsMessage
    }
  }

  return { natsMessageBySequence, pendingMessageCount }
}

export const runIngestionLoop = async ({
  orm,
  consumer,
  fetchBatchSize = 100,
  insertBatchSize = 100,
  useBuffer = false,
  changeAttributesOverride = (changeAttributes: RequiredEntityData<Change>) => changeAttributes,
  onTick = () => {},
  onAcked,
}: {
  orm: MikroORM
  consumer: Consumer
  fetchBatchSize?: number
  insertBatchSize?: number
  useBuffer?: boolean
  changeAttributesOverride?: (changeAttributes: RequiredEntityData<Change>) => RequiredEntityData<Change>
  onTick?: () => void
  onAcked?: (ackedStreamSequence: number) => Promise<void>
}) => {
  let lastStreamSequence: number | null = null
  let fetchedRecordBuffer = new FetchedRecordBuffer()

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Fetching
    logger.info('Fetching...')
    const { natsMessageBySequence, pendingMessageCount } = await fetchNatsMessages({
      consumer,
      fetchBatchSize,
      lastStreamSequence,
    })

    // A completed fetch proves the NATS round-trip still works; consumers use
    // this to expose liveness, since a stalled loop is otherwise invisible.
    onTick()

    // Last sequence tracking
    const sequences = Object.keys(natsMessageBySequence).sort((a, b) => Number(b) - Number(a)) // reverse sort
    if (sequences.length) {
      const lastBatchSequence = Number(sequences[0])
      if (!lastStreamSequence || lastBatchSequence > lastStreamSequence) {
        lastStreamSequence = lastBatchSequence
      }
    }

    // Stitching
    const now = new Date()
    const natsMessages = Object.values(natsMessageBySequence)
    const fetchedRecords = natsMessages
      .map((m: JsMsg) => FetchedRecord.fromNatsMessage(m, { now, changeAttributesOverride }))
      .filter((r) => r) as FetchedRecord[]
    const { stitchedFetchedRecords, newFetchedRecordBuffer, ackStreamSequence } = stitchFetchedRecords({
      fetchedRecordBuffer: fetchedRecordBuffer.addFetchedRecords(fetchedRecords),
      useBuffer,
    })
    fetchedRecordBuffer = newFetchedRecordBuffer

    logger.info(
      [
        `Fetched: ${natsMessages.length}`,
        `Saving: ${stitchedFetchedRecords.length}`,
        `Pending in buffer: ${fetchedRecordBuffer.size()}`,
        `Pending in stream: ${pendingMessageCount}`,
        `Ack sequence: ${ackStreamSequence ? `#${ackStreamSequence}` : 'none'}`,
        `Last sequence: #${lastStreamSequence}`,
      ].join('. '),
    )

    // Persisting and acking
    if (stitchedFetchedRecords.length) {
      try {
        await persistFetchedRecords({ orm, fetchedRecords: stitchedFetchedRecords, insertBatchSize })
      } catch (e) {
        logger.info(`Error while saving: ${e}`)
        throw e
      }
    }
    if (ackStreamSequence) {
      logger.debug(`Acking ${ackStreamSequence}...`)
      natsMessageBySequence[ackStreamSequence]?.ack()
    }

    // Under Limits retention an ack does not reclaim anything, so a stream that
    // fills stays full and DiscardPolicy.New then rejects every publish
    // permanently. Releasing what is already durable in Postgres is what keeps
    // back-pressure temporary rather than terminal.
    //
    // The floor comes from the consumer's own ack state rather than anything
    // held here, and runs every iteration rather than only after a fresh ack.
    // Both matter: once the stream is full there are no publishes, so no acks,
    // so a release driven by in-memory state would never run again after one
    // failed attempt or a restart.
    if (onAcked) {
      try {
        const { ack_floor: ackFloor } = await consumer.info()
        if (ackFloor.stream_seq > 0) {
          await onAcked(ackFloor.stream_seq)
        }
      } catch (e) {
        logger.info(`Error while releasing acked messages, will retry: ${e}`)
      }
    }

    if (stitchedFetchedRecords.length) {
      logger.debug('Sleeping...')
      await sleep(INSERT_INTERVAL_MS)
    }
  }
}
