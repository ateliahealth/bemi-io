// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import { logger } from './logger'
import { FetchedRecord } from './fetched-record'
import { FetchedRecordBuffer } from './fetched-record-buffer'

export const stitchFetchedRecords = ({
  fetchedRecordBuffer,
  useBuffer = false,
}: {
  fetchedRecordBuffer: FetchedRecordBuffer
  useBuffer: boolean
}) => {
  let stitchedFetchedRecords: FetchedRecord[] = []
  let maxSequence: number | undefined = undefined
  let maxSequenceBySubject: { [key: string]: number } = {}
  let newFetchedRecordBuffer = new FetchedRecordBuffer()

  fetchedRecordBuffer.forEach((subject, sortedFetchedRecords) => {
    if (
      sortedFetchedRecords.length &&
      (!maxSequence || sortedFetchedRecords[sortedFetchedRecords.length - 1].streamSequence > maxSequence)
    ) {
      maxSequence = sortedFetchedRecords[sortedFetchedRecords.length - 1].streamSequence
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

      // Last message without a pair - add it to the buffer
      if (
        useBuffer &&
        sameTransactionIdFetchedRecords.length === 1 && // No-pair change or context
        fetchedRecord === sortedFetchedRecords[sortedFetchedRecords.length - 1] // Last message
      ) {
        newFetchedRecordBuffer = newFetchedRecordBuffer.addFetchedRecord(fetchedRecord)
        return
      }

      // Context message (non-mutation) - skip it, it'll be used later
      if (fetchedRecord.isContextMessage()) {
        // Unless its change has not arrived. A change with no context is still
        // savable, so it can be released; a context with no change is not, and
        // dropping it here means a later ack purges it and the change is saved
        // with no application context. Buffer it instead.
        //
        // Keyed on whether the change has arrived, not on this being the only
        // record. A transaction can legitimately carry more than one context -
        // during a migration between emitters, both paths emit - and counting
        // records treated that as "already paired", so both were dropped and
        // the change was saved bare. One context survived a batch split; two
        // did not.
        const changeArrived = sameTransactionIdFetchedRecords.some((r) => r.isChange())
        if (useBuffer && !changeArrived) {
          newFetchedRecordBuffer = newFetchedRecordBuffer.addFetchedRecord(fetchedRecord)
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

  let ackStreamSequence
  if (newFetchedRecordBuffer.size()) {
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
        newFetchedRecordBuffer.sizeBySubject(subjectWithMaxSequence) === 0
      ) {
        subjectWithMaxSequence = subject
      }
    })
    ackStreamSequence = maxSequenceBySubject[subjectWithMaxSequence!]
  } else {
    ackStreamSequence = maxSequence
  }

  // Never ack at or past anything left in the buffer. The ack drives the purge,
  // so acking past a buffered record removes it from the stream while it exists
  // only in this process's memory - a restart before the next batch loses it.
  // Computed here rather than in the loop, because a record buffered early can
  // still be released later in the same pass.
  let minBufferedSequence: number | undefined = undefined
  newFetchedRecordBuffer.forEach((_subject, records) => {
    records.forEach((record) => {
      if (minBufferedSequence === undefined || record.streamSequence < minBufferedSequence) {
        minBufferedSequence = record.streamSequence
      }
    })
  })
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
