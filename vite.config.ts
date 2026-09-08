import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { compileUIKit } from '@iwsdk/vite-plugin-uikitml';
import { defineConfig } from 'vite';
import mkcert from 'vite-plugin-mkcert';

export default defineConfig({
  plugins: [
    // HTTPS is needed to test on a headset over LAN; set NO_HTTPS=1 for
    // plain-http local dev (or when mkcert can't download its binary).
    ...(process.env.NO_HTTPS ? [] : [mkcert()]),
    iwsdkDev({
      emulator: {
        device: 'metaQuest3'
      }
    }),
    compileUIKit({ sourceDir: 'ui', outputDir: 'public/ui' })
  ],
  server: { host: '0.0.0.0', port: 8082, open: true },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'esnext',
    rollupOptions: { input: './index.html' }
  },
  esbuild: { target: 'esnext' },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    esbuildOptions: { target: 'esnext' }
  },
  publicDir: 'public',
  base: './'
});
