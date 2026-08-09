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

Publishing is driven by a tag in its own namespace, so it never collides with
the `bemi-v*` tags that select what the deployment pipeline builds — the two
version independently and a shared pattern would make a release of one look
like a release of the other.

```sh
# bump "version" in context/package.json, commit, then:
git tag pg-change-context-v0.2.0
git push origin pg-change-context-v0.2.0
```

`.github/workflows/publish-context.yml` then runs the whole repository gate —
typecheck, tests, lint, formatting and the licence boundary — before it
publishes. Publishing is public and effectively irreversible, so it is the last
place to trade checks for speed. The boundary check matters most here: every
other consequence of breaking it is local, while this one would put
SSPL-derived code on a public registry under an MIT licence.

Two guards worth knowing about, because both failures are silent otherwise:

- **The tag must match the manifest version.** A mismatch publishes a version
  nobody asked for under a ref that does not describe it, and npm versions are
  immutable.
- **The tarball is inspected before publishing.** `LICENSE`, `README.md` and
  the built output must be present and `src/` must not be. The `files` field is
  easy to break and the damage is invisible until someone installs the result.

Provenance is attested — `publishConfig` sets it, so a local publish behaves
the same way as CI rather than the guarantee living only in the workflow.

### Authentication: trusted publishing, no token

CI authenticates by exchanging the workflow's short-lived OIDC identity for
publish rights. There is no npm token in this repository and no secret to
leak, rotate, or forget.

npm grants those rights because the package's **trusted publisher** on
npmjs.com names this repository and this workflow file. Two consequences worth
knowing before someone trips over them:

- **Renaming or moving `publish-context.yml` revokes publishing.** That is the
  mechanism working, not a fault. Update the trusted publisher first.
- **`NODE_AUTH_TOKEN` is deliberately never set.** npm prefers a token when one
  is present, so configuring one would silently keep using the credential this
  is meant to retire — and the publish would keep working, which is why nobody
  would notice.

#### First-time setup

Trusted publishing is configured per package, so it needs somewhere to attach.
Check npmjs.com first — if a trusted publisher can be configured for a package
that does not exist yet, skip straight to step 3.

1. Own the `@atelia` scope on npmjs.com.
2. Publish `0.0.1` once from a laptop, interactively, so the package exists.
3. On npmjs.com → the package → configure a trusted publisher: this repository,
   workflow `publish-context.yml`.
4. Revoke the token from step 2 if one was created. From then on every release
   is a tag.

If a token is ever used for a CI publish instead, it must have **"Bypass
two-factor authentication" enabled** — CI cannot answer an OTP prompt and the
publish fails with `EOTP`, which is a confusing error at the worst moment. A
token made for a laptop publish will have that off, correctly, and will not
work here.

## Licence

MIT — see `LICENSE` in this directory.

The rest of this repository is SSPL-1.0. This package is separate and imports
nothing from it, so that applications can link it without their own licensing
being affected. `scripts/licence-boundary.sh` enforces that separation as a
build failure rather than a convention, because the import that would break it
looks like a harmless cleanup.
