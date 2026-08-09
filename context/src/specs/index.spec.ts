// Copyright (c) 2026 Atelia Health. MIT licensed - see LICENSE.
import { describe, expect, test, vi } from 'vitest'

import {
  emitChangeContext,
  ChangeContextError,
  CONTEXT_MESSAGE_PREFIX,
  DEFAULT_MAX_CONTEXT_BYTES,
  RawQueryExecutor,
} from '../index'

const executor = () => {
  const calls: { query: string; values: unknown[] }[] = []
  const client: RawQueryExecutor = {
    $queryRawUnsafe: vi.fn(async (query: string, ...values: unknown[]) => {
      calls.push({ query, values })
      return []
    }),
  }
  return { client, calls }
}

describe('emitChangeContext', () => {
  test('emits a transactional message with the agreed prefix and a JSON payload', () => {
    const { client, calls } = executor()

    return emitChangeContext(client, { tenantId: 't1', userId: 'u1' }).then(() => {
      expect(calls).toHaveLength(1)
      // The literal `true` is the transactional flag. A non-transactional
      // message carries no transaction id, so it can never be paired with the
      // changes it describes, and it would not roll back with them.
      expect(calls[0].query).toContain('pg_logical_emit_message(true,')
      expect(calls[0].values).toStrictEqual([CONTEXT_MESSAGE_PREFIX, '{"tenantId":"t1","userId":"u1"}'])
    })
  })

  test('parameterises the payload rather than interpolating it', async () => {
    // Application data routinely contains quotes. Concatenation would be both
    // fragile and injectable, so the payload must never appear in the SQL.
    const { client, calls } = executor()
    const hostile = { note: `'); DROP TABLE changes; --` }

    await emitChangeContext(client, hostile)

    expect(calls[0].query).not.toContain('DROP TABLE')
    expect(calls[0].values[1]).toStrictEqual(JSON.stringify(hostile))
  })

  test('uses whatever client it is handed', async () => {
    // The contract that matters: this must run on the caller's transaction
    // client. The package cannot enforce that, but it must never reach for a
    // client of its own - which is the defect it exists to avoid.
    const tx = executor()
    const topLevel = executor()

    await emitChangeContext(tx.client, { tenantId: 't1' })

    expect(tx.calls).toHaveLength(1)
    expect(topLevel.calls).toHaveLength(0)
  })

  test('does not emit when there is no context', async () => {
    const { client, calls } = executor()

    // Returns without emitting rather than throwing: a background job or an
    // unauthenticated request legitimately has no context.
    await emitChangeContext(client, {})
    expect(calls).toHaveLength(0)
  })

  test('refuses an oversized context rather than truncating or skipping it', async () => {
    // Truncating produces malformed JSON downstream; skipping loses the record
    // silently. Refusing is the only outcome anyone finds out about.
    const { client, calls } = executor()
    const big = { blob: 'x'.repeat(DEFAULT_MAX_CONTEXT_BYTES) }

    await expect(emitChangeContext(client, big)).rejects.toThrow(ChangeContextError)
    expect(calls).toHaveLength(0)
  })

  test('measures the limit in bytes, not characters', async () => {
    const { client } = executor()
    // Four bytes each in UTF-8, so this is over the limit despite being well
    // under it by string length.
    const context = { blob: '𝄞'.repeat(DEFAULT_MAX_CONTEXT_BYTES / 3) }

    await expect(emitChangeContext(client, context)).rejects.toThrow(/bytes, over the/)
  })

  test('allows undefined values, which is what optional chaining produces', async () => {
    // `userId: request.user?.id` on an unauthenticated request. The field has
    // no value rather than a lost one, so this must not throw - doing so would
    // turn every anonymous request into an error.
    const { client, calls } = executor()

    await emitChangeContext(client, { tenantId: 't1', userId: undefined })
    expect(calls[0].values[1]).toStrictEqual('{"tenantId":"t1"}')
  })

  test('does not emit when every value was undefined', async () => {
    // Has keys, but no content once serialised. Emitting would put an empty
    // object in the log while reporting that context was recorded.
    const { client, calls } = executor()

    await emitChangeContext(client, { tenantId: undefined, userId: undefined })
    expect(calls).toHaveLength(0)
  })

  test('refuses values JSON.stringify would drop without complaint', async () => {
    // Functions and symbols vanish silently, so a field disappears between the
    // caller and the log while this reports success. That is precisely the
    // silent attribution loss this package exists to prevent.
    const { client, calls } = executor()

    await expect(emitChangeContext(client, { tenantId: 't1', fn: () => undefined })).rejects.toThrow(
      /silently dropped: fn/,
    )
    await expect(emitChangeContext(client, { tenantId: 't1', sym: Symbol('s') })).rejects.toThrow(/silently dropped/)
    expect(calls).toHaveLength(0)
  })

  test('catches unserialisable values nested inside the context', async () => {
    const { client } = executor()

    await expect(emitChangeContext(client, { actor: { id: 1, resolve: () => undefined } })).rejects.toThrow(
      /silently dropped: resolve/,
    )
  })

  test('rejects values that cannot be serialised', async () => {
    const { client, calls } = executor()
    const circular: Record<string, unknown> = {}
    circular.self = circular

    await expect(emitChangeContext(client, circular)).rejects.toThrow(ChangeContextError)
    expect(calls).toHaveLength(0)
  })

  test('rejects non-objects, including arrays', async () => {
    const { client } = executor()

    await expect(emitChangeContext(client, [] as unknown as Record<string, unknown>)).rejects.toThrow(
      /must be a plain object/,
    )
    await expect(emitChangeContext(client, null as unknown as Record<string, unknown>)).rejects.toThrow(
      /must be a plain object/,
    )
  })

  test('propagates executor failures instead of swallowing them', async () => {
    // A context that failed to emit means changes will be saved without it.
    // The caller is the only one who can decide whether that is acceptable.
    const client: RawQueryExecutor = {
      $queryRawUnsafe: vi.fn(async () => {
        throw new Error('connection terminated')
      }),
    }

    await expect(emitChangeContext(client, { tenantId: 't1' })).rejects.toThrow('connection terminated')
  })
})
