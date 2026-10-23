import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '#imports': 'vue' } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})