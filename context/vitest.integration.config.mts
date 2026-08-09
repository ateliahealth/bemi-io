// Copyright (c) 2026 Atelia Health. MIT licensed - see LICENSE.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/specs/**/*.int.spec.ts'],
    // Ordering matters when the gate asserts on what reached the audit table.
    fileParallelism: false,
    environment: 'node',
    // Prisma's engine start-up dwarfs the assertions.
    testTimeout: 30_000,
  },
})
