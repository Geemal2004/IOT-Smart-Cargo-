import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // Proxy REST API calls to the backend during dev
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      // Proxy Socket.IO handshake
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
