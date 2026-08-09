// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
process.env.LOG_LEVEL = 'INFO'

import { beforeAll, describe, expect, test, vi } from 'vitest'

import { stitchFetchedRecords } from '../stitching'
import { FetchedRecord, MESSAGE_PREFIX_CONTEXT, MESSAGE_PREFIX_HEARTBEAT } from '../fetched-record'
import { FetchedRecordBuffer } from '../fetched-record-buffer'

import { MOCKED_DATE, CHANGE_ATTRIBUTES } from './fixtures/fetched-records'

const findFetchedRecord = (fetchedRecords: FetchedRecord[], streamSequence: number) =>
  fetchedRecords.find((fetchedMessage) => fetchedMessage.streamSequence === streamSequence) as FetchedRecord

describe('stitchFetchedRecords', () => {
  beforeAll(() => {
    // A plain function, not an arrow: the code under test calls `new Date(ms)`,
    // and the fixtures expect the argument to be ignored in favour of the mock.
    vi.spyOn(global, 'Date').mockImplementation(function () {
      return MOCKED_DATE
    } as unknown as DateConstructor)
  })

  describe('when messages in the same batch', () => {
    test('stitches changes with context when out of order positions', () => {
      const subject = 'bemi-subject'
      const fetchedRecords = [
        new FetchedRecord({
          subject,
          streamSequence: 1,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId: 1, position: 141527096 },
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({
          subject,
          streamSequence: 2,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE, transactionId: 1, position: 141527704 },
        }),
        new FetchedRecord({
          subject,
          streamSequence: 3,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId: 2, position: 141527704 },
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({
          subject,
          streamSequence: 4,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE, transactionId: 2, position: 141527888 },
        }),
        new FetchedRecord({
          subject,
          streamSequence: 5,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId: 3, position: 141527400 },
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({
          subject,
          streamSequence: 6,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE, transactionId: 3, position: 141528024 },
        }),
      ]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords),
        useBuffer: true,
      })

      expect(result).toStrictEqual({
        stitchedFetchedRecords: [
          findFetchedRecord(fetchedRecords, 2).setContext(findFetchedRecord(fetchedRecords, 1).context()),
          findFetchedRecord(fetchedRecords, 4).setContext(findFetchedRecord(fetchedRecords, 3).context()),
          findFetchedRecord(fetchedRecords, 6).setContext(findFetchedRecord(fetchedRecords, 5).context()),
        ],
        ackStreamSequence: 6,
        newFetchedRecordBuffer: new FetchedRecordBuffer(),
      })
    })

    test('stitches changes with context when out of order stream sequences with 2+ records within the same transaction', () => {
      const subject = 'bemi-subject'
      const fetchedRecords = [
        new FetchedRecord({
          subject,
          streamSequence: 1,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId: 1 },
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({
          subject,
          streamSequence: 3,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId: 1 },
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({
          subject,
          streamSequence: 2,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE, transactionId: 1 },
        }),
        new FetchedRecord({
          subject,
          streamSequence: 4,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE, transactionId: 1 },
        }),
      ]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords),
        useBuffer: true,
      })

      expect(result).toStrictEqual({
        stitchedFetchedRecords: [
          findFetchedRecord(fetchedRecords, 2).setContext(findFetchedRecord(fetchedRecords, 1).context()),
          findFetchedRecord(fetchedRecords, 4).setContext(findFetchedRecord(fetchedRecords, 3).context()),
        ],
        ackStreamSequence: 4,
        newFetchedRecordBuffer: new FetchedRecordBuffer(),
      })
    })

    test('stitches context if it is first, ignores a heartbeat message', () => {
      const subject = 'bemi-subject'
      const fetchedRecords = [
        new FetchedRecord({
          subject,
          streamSequence: 1,
          changeAttributes: CHANGE_ATTRIBUTES.CREATE_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({ subject, streamSequence: 2, changeAttributes: CHANGE_ATTRIBUTES.CREATE }),
        new FetchedRecord({
          subject,
          streamSequence: 3,
          changeAttributes: CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
        }),
      ]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords),
        useBuffer: true,
      })

      expect(result).toStrictEqual({
        stitchedFetchedRecords: [
          findFetchedRecord(fetchedRecords, 2).setContext(findFetchedRecord(fetchedRecords, 1).context()),
        ],
        ackStreamSequence: 3,
        newFetchedRecordBuffer: new FetchedRecordBuffer(),
      })
    })

    test('stitches context if it is second and pauses on the one before last sequence', () => {
      const subject = 'bemi-subject'
      const fetchedRecords = [
        new FetchedRecord({ subject, streamSequence: 1, changeAttributes: CHANGE_ATTRIBUTES.CREATE }),
        new FetchedRecord({
          subject,
          streamSequence: 2,
          changeAttributes: CHANGE_ATTRIBUTES.CREATE_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({ subject, streamSequence: 3, changeAttributes: CHANGE_ATTRIBUTES.UPDATE }),
        new FetchedRecord({ subject, streamSequence: 4, changeAttributes: CHANGE_ATTRIBUTES.DELETE }),
      ]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords),
        useBuffer: true,
      })

      expect(result).toStrictEqual({
        stitchedFetchedRecords: [
          findFetchedRecord(fetchedRecords, 1).setContext(findFetchedRecord(fetchedRecords, 2).context()),
          findFetchedRecord(fetchedRecords, 3),
        ],
        ackStreamSequence: 3,
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([findFetchedRecord(fetchedRecords, 4)]),
      })
    })

    // A second, self-contained transaction so the trailing record is stitched
    // and released rather than buffered as an unpaired change of its own.
    const pairedTransaction = (subject: string, contextSequence: number, changeSequence: number) => [
      new FetchedRecord({
        subject,
        streamSequence: contextSequence,
        changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId: 2 },
        messagePrefix: MESSAGE_PREFIX_CONTEXT,
      }),
      new FetchedRecord({
        subject,
        streamSequence: changeSequence,
        changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE, transactionId: 2 },
      }),
    ]

    const orphanContext = (subject: string) =>
      new FetchedRecord({
        subject,
        streamSequence: 1,
        changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId: 1 },
        messagePrefix: MESSAGE_PREFIX_CONTEXT,
      })

    test('drops a context whose change never arrives, so the ack can advance', () => {
      // A transaction that wrote nothing, or only to excluded tables. Holding
      // it clamps the ack forever and the stream never purges.
      const subject = 'bemi-subject'
      const records = [orphanContext(subject), ...pairedTransaction(subject, 4999, 5000)]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(records),
        useBuffer: true,
      })

      expect(result.newFetchedRecordBuffer.size()).toEqual(0)
      expect(result.ackStreamSequence).toEqual(5000)
    })

    test('keeps a context whose change has simply not caught up yet', () => {
      const subject = 'bemi-subject'
      const records = [orphanContext(subject), ...pairedTransaction(subject, 19, 20)]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(records),
        useBuffer: true,
      })

      expect(result.newFetchedRecordBuffer.size()).toEqual(1)
      // Clamped below the buffered context so it is not purged from the stream.
      expect(result.ackStreamSequence).toBeUndefined()
    })

    test('buffers every context of a transaction whose change has not arrived', () => {
      // Two contexts happen while both emitters are live. Counting records
      // treated that as paired, so both were dropped and the change - arriving
      // in a later batch - was saved bare.
      const subject = 'bemi-subject'
      const contexts = [
        new FetchedRecord({
          subject,
          streamSequence: 1,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId: 1 },
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({
          subject,
          streamSequence: 2,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId: 1 },
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
      ]

      const firstBatch = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(contexts),
        useBuffer: true,
      })

      expect(firstBatch.stitchedFetchedRecords).toStrictEqual([])
      expect(firstBatch.newFetchedRecordBuffer).toStrictEqual(new FetchedRecordBuffer().addFetchedRecords(contexts))
      // Acking would purge both while they exist only in memory.
      expect(firstBatch.ackStreamSequence).toBeUndefined()

      const change = new FetchedRecord({
        subject,
        streamSequence: 3,
        changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE, transactionId: 1 },
      })

      const secondBatch = stitchFetchedRecords({
        fetchedRecordBuffer: firstBatch.newFetchedRecordBuffer.addFetchedRecords([change]),
        useBuffer: true,
      })

      expect(secondBatch.stitchedFetchedRecords).toHaveLength(1)
      expect(secondBatch.stitchedFetchedRecords[0].context()).toStrictEqual(contexts[0].context())
      expect(secondBatch.newFetchedRecordBuffer.size()).toEqual(0)
    })

    test('buffers an unpaired context even when a heartbeat follows it', () => {
      const subject = 'bemi-subject'
      const fetchedRecords = [
        new FetchedRecord({
          subject,
          streamSequence: 1,
          changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId: 1 },
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({
          subject,
          streamSequence: 2,
          changeAttributes: { ...CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE, transactionId: 2 },
          messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
        }),
      ]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords),
        useBuffer: true,
      })

      // The context must survive into the next batch. Acking the heartbeat
      // purges everything below it, so a context dropped here is gone and the
      // change it belongs to is later saved with no application context.
      expect(result.newFetchedRecordBuffer).toStrictEqual(
        new FetchedRecordBuffer().addFetchedRecords([findFetchedRecord(fetchedRecords, 1)]),
      )
      expect(result.stitchedFetchedRecords).toStrictEqual([])
      // Nothing may be acked: the buffered context is only in memory until the
      // next batch, so purging it from the stream would lose it on a restart.
      expect(result.ackStreamSequence).toBeUndefined()
    })

    test('acks the last heartbeat message if the buffer is empty', () => {
      const subject = 'bemi-subject'
      const fetchedRecords = [
        new FetchedRecord({
          subject,
          streamSequence: 1,
          changeAttributes: { ...CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE, transactionId: 1 },
          messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
        }),
        new FetchedRecord({
          subject,
          streamSequence: 3,
          changeAttributes: { ...CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE, transactionId: 3 },
          messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
        }),
        new FetchedRecord({
          subject,
          streamSequence: 2,
          changeAttributes: { ...CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE, transactionId: 2 },
          messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
        }),
      ]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords),
        useBuffer: true,
      })

      expect(result).toStrictEqual({
        stitchedFetchedRecords: [],
        ackStreamSequence: 3,
        newFetchedRecordBuffer: new FetchedRecordBuffer(),
      })
    })
  })

  describe('when messages from separate subjects', () => {
    test('stitches context across multiple subjects with a heartbeat message and pending context', () => {
      const subject1 = 'bemi-subject-1'
      const subject2 = 'bemi-subject-2'
      const fetchedRecords = [
        new FetchedRecord({
          subject: subject1,
          streamSequence: 1,
          changeAttributes: CHANGE_ATTRIBUTES.CREATE_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({ subject: subject1, streamSequence: 2, changeAttributes: CHANGE_ATTRIBUTES.CREATE }),

        new FetchedRecord({
          subject: subject2,
          streamSequence: 3,
          changeAttributes: CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
        }),
        new FetchedRecord({
          subject: subject2,
          streamSequence: 4,
          changeAttributes: {
            ...CHANGE_ATTRIBUTES.UPDATE_MESSAGE,
            transactionId: CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE.transactionId + 1,
          },
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
      ]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords),
        useBuffer: true,
      })

      expect(result).toStrictEqual({
        stitchedFetchedRecords: [
          findFetchedRecord(fetchedRecords, 2).setContext(findFetchedRecord(fetchedRecords, 1).context()),
        ],
        ackStreamSequence: 3,
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([findFetchedRecord(fetchedRecords, 4)]),
      })
    })

    test('stitches context across multiple subjects with a heartbeat message and pending change', () => {
      const subject1 = 'bemi-subject-1'
      const subject2 = 'bemi-subject-2'
      const fetchedRecords = [
        new FetchedRecord({
          subject: subject1,
          streamSequence: 1,
          changeAttributes: CHANGE_ATTRIBUTES.CREATE_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({ subject: subject1, streamSequence: 2, changeAttributes: CHANGE_ATTRIBUTES.CREATE }),

        new FetchedRecord({
          subject: subject2,
          streamSequence: 3,
          changeAttributes: CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
        }),
        new FetchedRecord({
          subject: subject2,
          streamSequence: 4,
          changeAttributes: {
            ...CHANGE_ATTRIBUTES.UPDATE,
            transactionId: CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE.transactionId + 1,
          },
        }),
      ]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords),
        useBuffer: true,
      })

      expect(result).toStrictEqual({
        stitchedFetchedRecords: [
          findFetchedRecord(fetchedRecords, 2).setContext(findFetchedRecord(fetchedRecords, 1).context()),
        ],
        ackStreamSequence: 3,
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([findFetchedRecord(fetchedRecords, 4)]),
      })
    })

    test('stitches context across multiple subjects with a single heartbeat message in one of them', () => {
      const subject1 = 'bemi-subject-1'
      const subject2 = 'bemi-subject-2'
      const fetchedRecords = [
        new FetchedRecord({
          subject: subject1,
          streamSequence: 1,
          changeAttributes: CHANGE_ATTRIBUTES.CREATE_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({ subject: subject1, streamSequence: 2, changeAttributes: CHANGE_ATTRIBUTES.CREATE }),
        new FetchedRecord({
          subject: subject2,
          streamSequence: 3,
          changeAttributes: CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
        }),
      ]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords),
        useBuffer: true,
      })

      expect(result).toStrictEqual({
        stitchedFetchedRecords: [
          findFetchedRecord(fetchedRecords, 2).setContext(findFetchedRecord(fetchedRecords, 1).context()),
        ],
        ackStreamSequence: 3,
        newFetchedRecordBuffer: new FetchedRecordBuffer(),
      })
    })
  })

  describe('when messages in separate batches', () => {
    test('stitches context for messages within the same shard after processing all batches', () => {
      const subject = 'bemi-subject'
      const fetchedRecords1 = [
        new FetchedRecord({ subject, streamSequence: 1, changeAttributes: CHANGE_ATTRIBUTES.CREATE }),
        new FetchedRecord({
          subject,
          streamSequence: 2,
          changeAttributes: CHANGE_ATTRIBUTES.CREATE_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({ subject, streamSequence: 3, changeAttributes: CHANGE_ATTRIBUTES.UPDATE }),
      ]

      const result1 = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords1),
        useBuffer: true,
      })
      expect(result1).toStrictEqual({
        stitchedFetchedRecords: [
          findFetchedRecord(fetchedRecords1, 1).setContext(findFetchedRecord(fetchedRecords1, 2).context()),
        ],
        ackStreamSequence: 1,
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([findFetchedRecord(fetchedRecords1, 3)]),
      })

      const fetchedRecords2 = [
        new FetchedRecord({
          subject,
          streamSequence: 4,
          changeAttributes: CHANGE_ATTRIBUTES.UPDATE_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({
          subject,
          streamSequence: 5,
          changeAttributes: CHANGE_ATTRIBUTES.DELETE_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
      ]

      const result2 = stitchFetchedRecords({
        fetchedRecordBuffer: result1.newFetchedRecordBuffer.addFetchedRecords(fetchedRecords2),
        useBuffer: true,
      })
      expect(result2).toStrictEqual({
        stitchedFetchedRecords: [
          findFetchedRecord(fetchedRecords1, 3).setContext(findFetchedRecord(fetchedRecords2, 4).context()),
        ],
        ackStreamSequence: 3,
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([findFetchedRecord(fetchedRecords2, 5)]),
      })
    })

    test('leaves only one before last pending record without context after processing all batches', () => {
      const subject = 'bemi-subject'
      const fetchedRecords1 = [
        new FetchedRecord({ subject, streamSequence: 1, changeAttributes: CHANGE_ATTRIBUTES.CREATE }),
      ]

      const result1 = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords1),
        useBuffer: true,
      })
      expect(result1).toStrictEqual({
        stitchedFetchedRecords: [],
        ackStreamSequence: undefined,
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords1),
      })

      const fetchedRecords2 = [
        new FetchedRecord({
          subject,
          streamSequence: 2,
          changeAttributes: CHANGE_ATTRIBUTES.CREATE_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_CONTEXT,
        }),
        new FetchedRecord({ subject, streamSequence: 3, changeAttributes: CHANGE_ATTRIBUTES.UPDATE }),
        new FetchedRecord({ subject, streamSequence: 4, changeAttributes: CHANGE_ATTRIBUTES.DELETE }),
      ]

      const result2 = stitchFetchedRecords({
        fetchedRecordBuffer: result1.newFetchedRecordBuffer.addFetchedRecords(fetchedRecords2),
        useBuffer: true,
      })
      expect(result2).toStrictEqual({
        stitchedFetchedRecords: [
          findFetchedRecord(fetchedRecords1, 1).setContext(findFetchedRecord(fetchedRecords2, 2).context()),
          findFetchedRecord(fetchedRecords2, 3),
        ],
        ackStreamSequence: 3,
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([findFetchedRecord(fetchedRecords2, 4)]),
      })
    })

    test('saves pending change messages after receiving a heartbeat message with a greater sequence number', () => {
      const subject = 'bemi-subject'
      const fetchedRecords1 = [
        new FetchedRecord({ subject, streamSequence: 1, changeAttributes: CHANGE_ATTRIBUTES.CREATE }),
      ]

      const result1 = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords1),
        useBuffer: true,
      })
      expect(result1).toStrictEqual({
        stitchedFetchedRecords: [],
        ackStreamSequence: undefined,
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(fetchedRecords1),
      })

      const fetchedRecords2 = [
        new FetchedRecord({
          subject,
          streamSequence: 2,
          changeAttributes: CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE,
          messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
        }),
      ]

      const result2 = stitchFetchedRecords({
        fetchedRecordBuffer: result1.newFetchedRecordBuffer.addFetchedRecords(fetchedRecords2),
        useBuffer: true,
      })
      expect(result2).toStrictEqual({
        stitchedFetchedRecords: [findFetchedRecord(fetchedRecords1, 1)],
        ackStreamSequence: 2,
        newFetchedRecordBuffer: new FetchedRecordBuffer(),
      })
    })
  })
})
