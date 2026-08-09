# @atelia/pg-change-context

Emits application context alongside PostgreSQL data changes, for consumers that
read it out of the write-ahead log via logical decoding.

MIT licensed. Independent of the rest of this repository, which is SSPL-1.0 —
see [Licence](#licence).

## What it does

One thing: issues `pg_logical_emit_message(true, '_bemi', <json>)` on a client
you give it.

```ts
import { emitChangeContext } from '@atelia/pg-change-context'

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

If you do wrap a previously-autocommitting write, keep the transaction to
exactly the emit and the write. Nothing else belongs inside it — no reads, no
service calls, no outbound requests. A write that used to hold a pooled
connection for a single statement now holds one for a transaction, on what is
usually the hottest path in the system, and anything added inside later
extends that hold. Worth asserting the statement count where the wrapping is
implemented, so a third statement fails a test rather than quietly changing
connection behaviour under load.

## Why the context is an argument

The context is passed in, rather than read from an ambient store the library
owns. That is deliberate.

An emitter that reads from async-local storage inherits whatever is in the
store, and a store populated with `enterWith` can persist into later work on
the same execution context. The failure that produces is not a missing
context — it is one request's tenant and user attached to another request's
changes. On any system where attribution matters, a change credited to the
wrong tenant is worse than a change credited to nobody: the first is wrong and
looks right, the second is merely incomplete and obvious.

Taking the value as an argument makes that class of bug unreachable here. If
the calling application keeps context in a request scope, it resolves it there
and passes the result — the scoping stays where the request lifecycle is
understood, and this package cannot outlive it.

## Behaviour

| Input                       | Result                              |
| --------------------------- | ----------------------------------- |
| Empty context `{}`          | Returns without emitting            |
| Context over the byte limit | Throws — never truncated or skipped |
| Non-serialisable value      | Throws                              |
| Not a plain object          | Throws                              |
| Executor rejects            | Propagates                          |

It returns `void`. Every failure throws, so there is no result to check and no
way to ignore one — a call that returns normally either emitted or had nothing
to emit. A boolean would have to be checked to mean anything, and an unchecked
return that quietly meant "did nothing" is the shape of bug this package exists
to remove.

Nothing here fails quietly. A context that did not reach the log means changes
will be attributed to nobody, and only the caller can decide whether that
should fail the write.

The limit defaults to 8 KiB and is per-call configurable. It is generous
relative to real payloads; exceeding it usually means something unintended is
being attached.

## Releasing

Tagged in its own namespace, separate from the `bemi-v*` tags that select what
the deployment pipeline builds.

```sh
# bump "version" in context/package.json, commit, then:
git tag pg-change-context-v0.2.0
git push origin pg-change-context-v0.2.0
```

`.github/workflows/publish-context.yml` runs the full repository gate before
publishing, and refuses if the tag disagrees with the manifest version or if
the tarball is missing its licence or build output.

## Licence

MIT — see `LICENSE` in this directory.

The rest of this repository is SSPL-1.0. This package is separate and imports
nothing from it, so that applications can link it without their own licensing
being affected. `scripts/licence-boundary.sh` enforces that separation as a
build failure rather than a convention, because the import that would break it
looks like a harmless cleanup.
