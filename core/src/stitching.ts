// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import { logger } from './logger'
import { FetchedRecord } from './fetched-record'
import { FetchedRecordBuffer } from './fetched-record-buffer'

// A transaction's records are contiguous in the stream, so a context whose
// change has not arrived within this many sequences is never getting one.
// Keeping it would clamp the ack forever and stall the stream.
const ORPHAN_CONTEXT_SEQUENCE_GAP = 1000

export const stitchFetchedRecords = ({
  fetchedRecordBuffer,
  useBuffer = false,
  orphanContextSequenceGap = ORPHAN_CONTEXT_SEQUENCE_GAP,
}: {
  fetchedRecordBuffer: FetchedRecordBuffer
  useBuffer: boolean
  orphanContextSequenceGap?: number
}) => {
  let stitchedFetchedRecords: FetchedRecord[] = []
  let maxSequence: number | undefined = undefined
  let maxSequenceBySubject: { [key: string]: number } = {}
  let newFetchedRecordBuffer = new FetchedRecordBuffer()

  fetchedRecordBuffer.forEach((subject, sortedFetchedRecords) => {
    const newestSubjectSequence = Math.max(...sortedFetchedRecords.map((r) => r.streamSequence))
    if (sortedFetchedRecords.length && (!maxSequence || newestSubjectSequence > maxSequence)) {
      maxSequence = newestSubjectSequence
    }

    let maxSubjectSequence: number | undefined = undefined

    sortedFetchedRecords.forEach((fetchedRecord) => {
      const transactionId = fetchedRecord.changeAttributes.transactionId.toString()
      const sameTransactionIdFetchedRecords = fetchedRecordBuffer.fetchedRecordsByTransactionId(subject, transactionId)
      const contextFetchedRecord = sameTransactionIdFetchedRecords.find((r) => r.isContextMessage())

      // If it's a heartbeat message/change, use its sequence number
      if (fetchedRecord.isHeartbeatMessage()) {
        logger.debug(`Ignoring heartbeat message`)
        if (!maxSubjectSequence || maxSubjectSequence < fetchedRecord.streamSequence) {
          maxSubjectSequence = fetchedRecord.streamSequence
          maxSequenceBySubject = { ...maxSequenceBySubject, [subject]: maxSubjectSequence }
        }
        return
      }

      // Last change without a pair - add it to the buffer
      if (
        useBuffer &&
        fetchedRecord.isChange() &&
        sameTransactionIdFetchedRecords.length === 1 &&
        fetchedRecord.streamSequence === newestSubjectSequence
      ) {
        newFetchedRecordBuffer = newFetchedRecordBuffer.addFetchedRecord(fetchedRecord)
        return
      }

      if (fetchedRecord.isContextMessage()) {
        const paired = fetchedRecord.paired || sameTransactionIdFetchedRecords.some((r) => r.isChange())
        // Debezium publishes each transaction contiguously, in commit order rather than xid order.
        const transactionEnded =
          newestSubjectSequence > Math.max(...sameTransactionIdFetchedRecords.map((r) => r.streamSequence))
        // Dropped rather than held forever if its change never comes - a
        // transaction that wrote nothing, or wrote only to excluded tables.
        // Holding it clamps the ack, so the stream never purges and fills.
        const pastOrphanGap =
          maxSequence !== undefined && maxSequence - fetchedRecord.streamSequence > orphanContextSequenceGap
        const orphaned = !paired && (transactionEnded || pastOrphanGap)
        if (useBuffer && !transactionEnded && !orphaned) {
          newFetchedRecordBuffer = newFetchedRecordBuffer.addFetchedRecord(
            paired && !fetchedRecord.paired ? fetchedRecord.asPaired() : fetchedRecord,
          )
        } else if (orphaned) {
          logger.info(
            `Dropping context message #${fetchedRecord.streamSequence} whose change never arrived (stream at #${maxSequence})`,
          )
        }
        return
      }

      //////////////////////////////////////////////////////////////////////////////////////////////////////////////////

      // Update ack sequence number
      if (!maxSubjectSequence || maxSubjectSequence < fetchedRecord.streamSequence) {
        maxSubjectSequence = fetchedRecord.streamSequence
        maxSequenceBySubject = { ...maxSequenceBySubject, [subject]: maxSubjectSequence }
      }

      if (contextFetchedRecord) {
        // Stitch with context message change message if it exists
        stitchedFetchedRecords = [...stitchedFetchedRecords, fetchedRecord.setContext(contextFetchedRecord.context())]
      } else {
        // Return mutation change message as is without stitching
        stitchedFetchedRecords = [...stitchedFetchedRecords, fetchedRecord]
      }
    })
  })

  const ackBlockingSequencesBySubject: { [subject: string]: number[] } = {}
  newFetchedRecordBuffer.forEach((subject, records) => {
    ackBlockingSequencesBySubject[subject] = records.filter((r) => !r.paired).map((r) => r.streamSequence)
  })
  const ackBlockingSequences = Object.values(ackBlockingSequencesBySubject).flat()

  let ackStreamSequence
  if (ackBlockingSequences.length) {
    let subjectWithMaxSequence: string | undefined = undefined
    Object.keys(maxSequenceBySubject).forEach((subject) => {
      // Set an initial subject
      if (!subjectWithMaxSequence) {
        subjectWithMaxSequence = subject
        return
      }
      // If the previous subject has a lower sequence number and it doesn't have any messages in the buffer, use the new subject
      if (
        maxSequenceBySubject[subject] > maxSequenceBySubject[subjectWithMaxSequence] &&
        !ackBlockingSequencesBySubject[subjectWithMaxSequence]?.length
      ) {
        subjectWithMaxSequence = subject
      }
    })
    ackStreamSequence = maxSequenceBySubject[subjectWithMaxSequence!]
  } else {
    ackStreamSequence = maxSequence
  }

  // Never ack at or past an unpaired record left in the buffer. The ack drives the purge,
  // so acking past a buffered record removes it from the stream while it exists
  // only in this process's memory - a restart before the next batch loses it.
  // Computed here rather than in the loop, because a record buffered early can
  // still be released later in the same pass.
  const minBufferedSequence = ackBlockingSequences.length ? Math.min(...ackBlockingSequences) : undefined
  if (
    ackStreamSequence !== undefined &&
    minBufferedSequence !== undefined &&
    ackStreamSequence >= minBufferedSequence
  ) {
    ackStreamSequence = minBufferedSequence > 1 ? minBufferedSequence - 1 : undefined
  }

  logger.debug({
    stitched: stitchedFetchedRecords,
    buffer: newFetchedRecordBuffer.store,
    ackStreamSequence,
  })

  return {
    stitchedFetchedRecords,
    newFetchedRecordBuffer,
    ackStreamSequence,
  }
}
