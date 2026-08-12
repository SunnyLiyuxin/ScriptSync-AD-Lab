import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // API 请求代理到 Python FastAPI
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // WebSocket 代理到 Node.js y-websocket 协作服务端
      '/collab-ws': {
        target: 'ws://localhost:1234',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace('/collab-ws', ''),
      },
    },
  },
});
