// Copyright (c) 2026 Atelia Health. MIT licensed - see LICENSE.
//
// Runs against a live Postgres, from the compose gate rather than `pnpm test`.
//
// This exists because 0.1.0 shipped completely broken: pg_logical_emit_message
// returns pg_lsn, which Prisma cannot deserialize, so every call wrote the
// message and then threw. The unit tests passed and the gate passed, because
// the gate drives raw SQL through psql, which handles pg_lsn without complaint.
// Nothing called the package the way its only consumer does.
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { emitChangeContext } from '../index'

const prisma = new PrismaClient()

describe('emitChangeContext through a Prisma client', () => {
  beforeAll(async () => {
    await prisma.$connect()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('resolves on the top-level client', async () => {
    await expect(emitChangeContext(prisma, { tenantId: 't1', userId: 'u1' })).resolves.toBeUndefined()
  })

  test('resolves on an interactive transaction client', async () => {
    // The real call site. A driver-level failure here rolls back the writes it
    // was supposed to attribute.
    await expect(
      prisma.$transaction(async (tx) => {
        await emitChangeContext(tx, { tenantId: 't1' })
        return 'committed'
      }),
    ).resolves.toEqual('committed')
  })

  test('a throwing transaction rolls back rather than being masked by the emit', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await emitChangeContext(tx, { tenantId: 't1' })
        throw new Error('deliberate')
      }),
    ).rejects.toThrow('deliberate')
  })

  test('payloads with quotes survive parameterisation', async () => {
    await expect(emitChangeContext(prisma, { note: `'); DROP TABLE todos; --` })).resolves.toBeUndefined()
  })
})
