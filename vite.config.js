import { defineConfig } from 'vite'

export default defineConfig({
  base: '/File-transfer-project-using-wifi/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'index.html',
    },
  },
  server: {
    port: 5173,
    open: true,
  },
})
