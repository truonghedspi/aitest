import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `pnpm --filter @aitest/web-client dev` chạy giao diện ở chế độ phát triển, chuyển /ws tới web host.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://127.0.0.1:4300', ws: true } },
  },
})
