// Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
// modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/specs/**/*.spec.ts'],
    environment: 'node',
  },
})
