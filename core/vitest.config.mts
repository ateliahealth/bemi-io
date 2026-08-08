import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/specs/**/*.spec.ts'],
    environment: 'node',
  },
})
