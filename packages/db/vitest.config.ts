import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Compile-time only; checked by `test:types`.
    exclude: ['**/node_modules/**', 'test/types.test.ts'],
  },
})
