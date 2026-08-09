// Copyright (c) 2026 Atelia Health. MIT licensed - see LICENSE.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/specs/**/*.spec.ts'],
    environment: 'node',
  },
})
