# @ateliahealth/pg-change-context

Emits application context alongside PostgreSQL data changes, for consumers that
read it out of the write-ahead log via logical decoding.

MIT licensed. Independent of the rest of this repository, which is SSPL-1.0 —
see [Licence](#licence).

## What it does

One thing: issues `pg_logical_emit_message(true, '_bemi', <json>)` on a client
you give it.

```ts
import { emitChangeContext } from '@ateliahealth/pg-change-context'

await prisma.$transaction(async (tx) => {
  await emitChangeContext(tx, { tenantId, userId })
  await tx.thing.update({ ... })
})
```

The message is transactional, so it becomes visible only if the transaction
commits, and a rollback discards it exactly as it discards the writes. A CDC
consumer pairs it to the changes by transaction id.

## The one thing to get right

**Emit on the same client the writes go to.** Inside an interactive transaction
that is the transaction client, not the top-level one.

Emitting on the top-level client sends the message over a different connection,
in a different transaction. It then has a different transaction id, so it pairs
with nothing, and it does not roll back with the writes. Both failures are
silent: changes are recorded correctly but with no context, which is
indistinguishable from a code path that never set any.

## What this package deliberately does not do

**It does not decide whether to open a transaction.**

A lone write with no enclosing transaction is the awkward case. Prisma
autocommits it, so emitting and then writing produces two transactions, two
transaction ids, and no pairing. Making them atomic means opening a transaction
— but doing that when the caller _already_ has one is what breaks the caller's
transaction.

So the rule is: wrap when there is no caller transaction, never wrap when there
is. This package cannot evaluate that rule, because only the application's
transaction manager knows whether one is open. Guessing produces exactly the
defect this package exists to avoid.

Own that decision where transactions are already managed — a CLS-scoped
transaction host, a unit-of-work, or an explicit `$transaction` at the call
site — and call `emitChangeContext` with the client that manager hands you.

## Behaviour

| Input                       | Result                              |
| --------------------------- | ----------------------------------- |
| Empty context `{}`          | No emit, returns `false`            |
| Context over the byte limit | Throws — never truncated or skipped |
| Non-serialisable value      | Throws                              |
| Not a plain object          | Throws                              |
| Executor rejects            | Propagates                          |

Nothing here fails quietly. A context that did not reach the log means changes
will be attributed to nobody, and only the caller can decide whether that
should fail the write.

The limit defaults to 8 KiB and is per-call configurable. It is generous
relative to real payloads; exceeding it usually means something unintended is
being attached.

## Licence

MIT — see `LICENSE` in this directory.

The rest of this repository is SSPL-1.0. This package is separate and imports
nothing from it, so that applications can link it without their own licensing
being affected. `scripts/licence-boundary.sh` enforces that separation as a
build failure rather than a convention, because the import that would break it
looks like a harmless cleanup.
