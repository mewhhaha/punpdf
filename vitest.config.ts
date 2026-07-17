import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.agents/**', '.claude/**'],
    isolate: false,
    maxWorkers: 1,
  },
})
