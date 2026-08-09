// Copyright (c) 2026 Atelia Health. MIT licensed - see LICENSE in this
// directory. Independent of the SSPL-licensed packages in this repository:
// this package imports nothing from them and must not start, because it is
// linked into applications whose licence would otherwise be affected.

// Duplicated deliberately rather than imported from the consumer package.
// Importing it would pull an SSPL dependency into every application that links
// this one, which is the entire reason this package is separate. Four
// characters of duplication is the cheaper side of that trade.
//
// This is a wire contract, not an implementation detail: the consumer matches
// on it exactly when deciding whether a logical message carries context.
export const CONTEXT_MESSAGE_PREFIX = '_bemi'

// Generous relative to real payloads - production context averages a few
// hundred bytes. Exceeding it means something unintended is being attached,
// which is worth surfacing rather than absorbing.
export const DEFAULT_MAX_CONTEXT_BYTES = 8192

// Structural, so this works with a PrismaClient, a transaction client, or
// anything else exposing the same method. Typing it against Prisma would make
// this package depend on a specific ORM and version for no benefit.
export interface RawQueryExecutor {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>
}

export class ChangeContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChangeContextError'
  }
}

// `true` is the transactional flag and is not negotiable.
//
// A non-transactional message is written to WAL immediately and carries no
// transaction id. Consumers pair context to changes by transaction id, so a
// non-transactional message is unpairable - and a consumer that assumes the id
// is present fails on null rather than degrading.
//
// Being transactional also gives the property that makes this correct: the
// message becomes visible only if the transaction commits. A rollback discards
// the context exactly as it discards the writes, with no special handling.
const EMIT_SQL = 'SELECT pg_logical_emit_message(true, $1, $2)'

/**
 * Emits application context for the changes made in the caller's transaction.
 *
 * The executor MUST be the same client the writes are made on. Inside an
 * interactive transaction that is the transaction client, not the top-level
 * one - issuing this on the top-level client sends it over a different
 * connection, in a different transaction, so it neither pairs with the changes
 * nor rolls back with them.
 *
 * That is the single most important property here and the easiest to get
 * wrong, because getting it wrong produces changes saved with no context:
 * silent, and indistinguishable from an application path that never set any.
 *
 * Returns false without emitting when there is no context to record.
 */
export const emitChangeContext = async (
  executor: RawQueryExecutor,
  context: Record<string, unknown>,
  { maxBytes = DEFAULT_MAX_CONTEXT_BYTES }: { maxBytes?: number } = {},
): Promise<boolean> => {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new ChangeContextError('Context must be a plain object')
  }

  // Nothing to record. Emitting would produce a message the consumer resolves
  // to an empty object anyway, at the cost of a WAL record per transaction.
  if (Object.keys(context).length === 0) return false

  // JSON.stringify drops function and symbol values without complaint, so a
  // field can vanish between the caller and the log while this returns
  // success. That is the failure this package exists to prevent, so they are
  // rejected rather than dropped.
  //
  // `undefined` is deliberately not rejected. It is what optional chaining
  // produces - `userId: user?.id` on an unauthenticated request - and it means
  // the field genuinely has no value, not that a value was lost. Throwing
  // there would turn every anonymous request into an error.
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

  // JSON.stringify returns undefined for values it cannot represent at the top
  // level; every such case is caught above, but the type does not say so.
  if (payload === undefined) {
    throw new ChangeContextError('Context serialised to undefined')
  }

  // Checked after serialising, not before. A context of nothing but undefined
  // values has keys but no content, and emitting it would put an empty object
  // in the log while reporting that context was recorded.
  if (payload === '{}') return false

  const byteLength = Buffer.byteLength(payload, 'utf8')
  if (byteLength > maxBytes) {
    // Deliberately not truncated or skipped. A silently dropped context is the
    // failure this exists to avoid, and a silently truncated one produces
    // malformed JSON downstream. Refusing is the only option that tells anyone.
    throw new ChangeContextError(`Context is ${byteLength} bytes, over the ${maxBytes} byte limit`)
  }

  // Parameterised rather than interpolated. The payload is application data and
  // frequently contains quotes; building this statement by concatenation would
  // be both fragile and injectable.
  await executor.$queryRawUnsafe(EMIT_SQL, CONTEXT_MESSAGE_PREFIX, payload)

  return true
}
