process.env.NO_PROXY = 'localhost,127.0.0.1,0.0.0.0';
process.env.no_proxy = 'localhost,127.0.0.1,0.0.0.0';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3300,
    host: '0.0.0.0',
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
      '/v1': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
      '/media': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      }
    }
  }
});
