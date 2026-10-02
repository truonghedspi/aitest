import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Commit git lúc build giao diện; so với commit của Host để phát hiện giao diện chưa được build lại sau khi cập nhật mã. */
function gitVersion() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return dirty ? `${commit}*` : commit
  } catch {
    return ''
  }
}

// `pnpm --filter @aitest/web-client dev` chạy giao diện ở chế độ phát triển, chuyển /ws tới web host.
export default defineConfig({
  plugins: [react()],
  define: { __UI_VERSION__: JSON.stringify(gitVersion()) },
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://127.0.0.1:4300', ws: true } },
  },
})
