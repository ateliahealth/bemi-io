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
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([
          findFetchedRecord(fetchedRecords, 5).asPaired(),
        ]),
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
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([
          findFetchedRecord(fetchedRecords, 1).asPaired(),
          findFetchedRecord(fetchedRecords, 3).asPaired(),
        ]),
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

    // A second, self-contained transaction, ended by a heartbeat so its context
    // is released and its change is not buffered as an unpaired one.
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
      new FetchedRecord({
        subject,
        streamSequence: changeSequence + 1,
        changeAttributes: { ...CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE, transactionId: 3 },
        messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
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
      expect(result.ackStreamSequence).toEqual(5001)
    })

    test('drops an unpaired context once another transaction follows it, within the orphan gap', () => {
      const subject = 'bemi-subject'
      const records = [orphanContext(subject), ...pairedTransaction(subject, 19, 20)]

      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords(records),
        useBuffer: true,
      })

      expect(result.newFetchedRecordBuffer.size()).toEqual(0)
      expect(result.ackStreamSequence).toEqual(21)
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
      expect(secondBatch.newFetchedRecordBuffer).toStrictEqual(
        new FetchedRecordBuffer().addFetchedRecords(contexts.map((context) => context.asPaired())),
      )
      expect(secondBatch.ackStreamSequence).toEqual(3)
    })

    test('drops an unpaired context once a heartbeat follows it', () => {
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

      expect(result.newFetchedRecordBuffer).toStrictEqual(new FetchedRecordBuffer())
      expect(result.stitchedFetchedRecords).toStrictEqual([])
      expect(result.ackStreamSequence).toEqual(2)
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
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([
          findFetchedRecord(fetchedRecords, 1).asPaired(),
          findFetchedRecord(fetchedRecords, 4),
        ]),
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
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([
          findFetchedRecord(fetchedRecords, 1).asPaired(),
          findFetchedRecord(fetchedRecords, 4),
        ]),
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
        newFetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([
          findFetchedRecord(fetchedRecords, 1).asPaired(),
        ]),
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

  describe('when a transaction is split across batches', () => {
    const subject = 'bemi-subject'

    const context = (streamSequence: number, transactionId: number) =>
      new FetchedRecord({
        subject,
        streamSequence,
        changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE_MESSAGE, transactionId },
        messagePrefix: MESSAGE_PREFIX_CONTEXT,
      })

    const change = (streamSequence: number, transactionId: number) =>
      new FetchedRecord({
        subject,
        streamSequence,
        changeAttributes: { ...CHANGE_ATTRIBUTES.CREATE, transactionId },
      })

    const heartbeat = (streamSequence: number, transactionId: number) =>
      new FetchedRecord({
        subject,
        streamSequence,
        changeAttributes: { ...CHANGE_ATTRIBUTES.HEARTBEAT_MESSAGE, transactionId },
        messagePrefix: MESSAGE_PREFIX_HEARTBEAT,
      })

    const runBatches = (batches: FetchedRecord[][], options: { orphanContextSequenceGap?: number } = {}) => {
      let buffer = new FetchedRecordBuffer()
      const saved: FetchedRecord[] = []
      const acks: (number | undefined)[] = []
      batches.forEach((batch) => {
        const result = stitchFetchedRecords({
          fetchedRecordBuffer: buffer.addFetchedRecords(batch),
          useBuffer: true,
          ...options,
        })
        buffer = result.newFetchedRecordBuffer
        saved.push(...result.stitchedFetchedRecords)
        acks.push(result.ackStreamSequence)
      })
      return { contextBySequence: new Map(saved.map((r) => [r.streamSequence, r.context()])), acks, buffer }
    }

    test('stitches the changes in the next batch with the context from the previous one', () => {
      const ctx = context(1, 500)
      const { contextBySequence, acks } = runBatches([
        [ctx, change(2, 500)],
        [change(3, 500), context(4, 501), change(5, 501)],
      ])

      expect(contextBySequence.get(2)).toStrictEqual(ctx.context())
      expect(contextBySequence.get(3)).toStrictEqual(ctx.context())
      expect(acks).toStrictEqual([2, 5])
    })

    test('stitches the changes in the next batch when the context ends the previous one', () => {
      const ctx = context(2, 500)
      const { contextBySequence } = runBatches([
        [change(1, 499), ctx],
        [change(3, 500), change(4, 500), change(5, 501)],
      ])

      expect(contextBySequence.get(3)).toStrictEqual(ctx.context())
      expect(contextBySequence.get(4)).toStrictEqual(ctx.context())
    })

    test('keeps the context across several batches without holding back the ack', () => {
      const ctx = context(1, 500)
      const { contextBySequence, acks, buffer } = runBatches([
        [ctx, change(2, 500)],
        [change(3, 500), change(4, 500)],
        [change(5, 500), heartbeat(6, 501)],
      ])

      ;[2, 3, 4, 5].forEach((sequence) => expect(contextBySequence.get(sequence)).toStrictEqual(ctx.context()))
      expect(acks).toStrictEqual([2, 4, 6])
      expect(buffer.size()).toEqual(0)
    })

    test('carries the same held context object across batches instead of re-wrapping it', () => {
      const first = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([context(1, 500), change(2, 500)]),
        useBuffer: true,
      })
      const second = stitchFetchedRecords({
        fetchedRecordBuffer: first.newFetchedRecordBuffer.addFetchedRecords([change(3, 500)]),
        useBuffer: true,
      })

      const held = (result: typeof first) =>
        result.newFetchedRecordBuffer.fetchedRecordsByTransactionId(subject, '500').find((r) => r.isContextMessage())
      expect(held(second)).toBe(held(first))
    })

    test('releases the context of a transaction that ended exactly at the batch boundary', () => {
      const { acks, buffer } = runBatches([[context(1, 500), change(2, 500)], [heartbeat(3, 501)]])

      expect(acks).toStrictEqual([2, 3])
      expect(buffer.size()).toEqual(0)
    })

    test('tells the transaction ended by stream order, not by transaction id', () => {
      const ctx = context(3, 500)
      const { contextBySequence } = runBatches([
        [context(1, 600), change(2, 600), ctx, change(4, 500)],
        [change(5, 500), heartbeat(6, 700)],
      ])

      expect(contextBySequence.get(4)).toStrictEqual(ctx.context())
      expect(contextBySequence.get(5)).toStrictEqual(ctx.context())
    })

    test('does not age out the context of a transaction larger than the orphan gap', () => {
      const ctx = context(1, 500)
      const { contextBySequence } = runBatches(
        [
          [ctx, change(2, 500), change(3, 500), change(4, 500)],
          [change(5, 500), change(6, 500), heartbeat(7, 501)],
        ],
        { orphanContextSequenceGap: 2 },
      )

      ;[2, 3, 4, 5, 6].forEach((sequence) => expect(contextBySequence.get(sequence)).toStrictEqual(ctx.context()))
    })

    test('buffers the newest unpaired change by stream order, not by transaction id', () => {
      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([change(1, 900), change(2, 500)]),
        useBuffer: true,
      })

      expect(result.stitchedFetchedRecords.map((r) => r.streamSequence)).toStrictEqual([1])
      expect(result.newFetchedRecordBuffer.size()).toEqual(1)
      expect(result.newFetchedRecordBuffer.fetchedRecordsByTransactionId(subject, '500')).toHaveLength(1)
      expect(result.ackStreamSequence).toEqual(1)
    })

    test('acks the newest record by stream order, not by transaction id', () => {
      const result = stitchFetchedRecords({
        fetchedRecordBuffer: new FetchedRecordBuffer().addFetchedRecords([change(1, 600), heartbeat(2, 550)]),
        useBuffer: true,
      })

      expect(result.stitchedFetchedRecords.map((r) => r.streamSequence)).toStrictEqual([1])
      expect(result.ackStreamSequence).toEqual(2)
    })
  })
})
