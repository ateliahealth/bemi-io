// Copyright (c) 2026 Atelia Health. MIT licensed - see LICENSE.
//
// Writes through a real Prisma client so the compose gate can assert what
// reached the audit table. This half only produces the traffic; the pairing
// assertions live in the gate, which can see both databases.
//
// The seam being covered is the one a consumer cannot test: an emit that looks
// correct at the call site but pairs with nothing downstream - wrong prefix,
// wrong transaction, a shape the worker cannot read. All silent.
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, test } from 'vitest'

import { emitChangeContext } from '../index'

const prisma = new PrismaClient()

// The worker stores context as opaque jsonb and reads no key, so these names
// are illustrative rather than required. What is asserted is that the record
// pairs at all and that more than one field survives the round trip.
const context = (tenantId: string) => ({
  tenantId,
  userId: `user-${tenantId}`,
  requestId: `request-${tenantId}`,
})

describe('context pairing through the pipeline', () => {
  beforeAll(async () => {
    await prisma.$connect()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('one context covers every write in its transaction', async () => {
    await prisma.$transaction(async (tx) => {
      await emitChangeContext(tx, context('pair-tx'))
      await tx.$executeRawUnsafe(`INSERT INTO todos (title) VALUES ('pair-tx-a')`)
      await tx.$executeRawUnsafe(`INSERT INTO todos (title) VALUES ('pair-tx-b')`)
    })
  })

  test('a lone write wrapped only to carry the emit', async () => {
    // The path worth 35% of tenant attribution: a single autocommit write that
    // has to be wrapped, because the emit and the write must share a
    // transaction id or they pair with nothing.
    await prisma.$transaction(async (tx) => {
      await emitChangeContext(tx, context('pair-lone'))
      await tx.$executeRawUnsafe(`INSERT INTO todos (title) VALUES ('pair-lone')`)
    })
  })

  test('a rolled back transaction emits nothing that survives', async () => {
    await prisma
      .$transaction(async (tx) => {
        await emitChangeContext(tx, context('pair-rollback'))
        await tx.$executeRawUnsafe(`INSERT INTO todos (title) VALUES ('pair-rollback')`)
        throw new Error('deliberate')
      })
      .catch(() => undefined)
  })
})
