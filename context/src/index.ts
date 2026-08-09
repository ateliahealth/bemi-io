// Copyright (c) 2026 Atelia Health. MIT licensed - see LICENSE in this
// directory. Imports nothing from the SSPL packages in this repository and
// must not start; scripts/licence-boundary.sh enforces it.

// Duplicated rather than imported from core: importing would pull an SSPL
// dependency into every application linking this one. Wire contract - the
// consumer matches on it exactly.
export const CONTEXT_MESSAGE_PREFIX = '_bemi'

// Generous: real payloads are a few hundred bytes, so exceeding it means
// something unintended is attached.
export const DEFAULT_MAX_CONTEXT_BYTES = 8192

// Structural, so a PrismaClient or a transaction client satisfies it without
// this package depending on an ORM.
export interface RawQueryExecutor {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>
}

export class ChangeContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChangeContextError'
  }
}

// `true` is not negotiable: a non-transactional message carries no transaction
// id, and consumers pair context to changes by it. Being transactional is also
// what makes a rollback discard the context along with the writes.
const EMIT_SQL = 'SELECT pg_logical_emit_message(true, $1, $2)'

/**
 * Emits application context for the changes in the caller's transaction.
 *
 * The executor MUST be the client the writes go to - inside an interactive
 * transaction that is the transaction client. On the top-level client it goes
 * over another connection in another transaction, so it pairs with nothing and
 * does not roll back with the writes. Both failures are silent.
 *
 * Returns void; every failure throws.
 */
export const emitChangeContext = async (
  executor: RawQueryExecutor,
  context: Record<string, unknown>,
  { maxBytes = DEFAULT_MAX_CONTEXT_BYTES }: { maxBytes?: number } = {},
): Promise<void> => {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new ChangeContextError('Context must be a plain object')
  }

  // Not an error: a background job or unauthenticated request legitimately has
  // no context.
  if (Object.keys(context).length === 0) return

  // JSON.stringify drops functions and symbols silently, so a field can vanish
  // between caller and log while this reports success. `undefined` is allowed:
  // it is what `user?.id` produces on an anonymous request, and means absent
  // rather than lost.
  const droppedFields: string[] = []
  let payload: string | undefined
  try {
    payload = JSON.stringify(context, (key, value) => {
      const type = typeof value
      if (type === 'function' || type === 'symbol') {
        droppedFields.push(key)
        return undefined
      }
      return value
    })
  } catch (e) {
    throw new ChangeContextError(`Context is not JSON-serialisable: ${(e as Error).message}`)
  }

  if (droppedFields.length) {
    throw new ChangeContextError(
      `Context fields cannot be serialised and would be silently dropped: ${droppedFields.join(', ')}`,
    )
  }

  // Caught above in every real case, but the type does not say so.
  if (payload === undefined) {
    throw new ChangeContextError('Context serialised to undefined')
  }

  // After serialising, not before: all-undefined values have keys but no
  // content.
  if (payload === '{}') return

  const byteLength = Buffer.byteLength(payload, 'utf8')
  if (byteLength > maxBytes) {
    // Not truncated (malformed JSON downstream) and not skipped (silent loss).
    throw new ChangeContextError(`Context is ${byteLength} bytes, over the ${maxBytes} byte limit`)
  }

  // Parameterised: the payload is application data and contains quotes.
  await executor.$queryRawUnsafe(EMIT_SQL, CONTEXT_MESSAGE_PREFIX, payload)
}
