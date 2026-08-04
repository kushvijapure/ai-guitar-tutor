import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  worker: {
    // The analysis worker uses ES module imports; the classic-worker output
    // format cannot express those.
    format: 'es',
  },

  build: {
    assetsInlineLimit(filePath) {
      // Never inline the AudioWorklet as a data: URL.
      //
      // Vite would otherwise base64 it into the main bundle, because it is
      // under the default 4 KB inline threshold. addModule() does accept a
      // data: URL in Chrome and Firefox, but any Content-Security-Policy
      // without `script-src data:` blocks it, and Safari has been unreliable
      // with data-URL worklets. Emitting a real file costs one request and
      // removes an entire class of deployment-only failure.
      if (filePath.includes('capture-worklet')) return false;
      // Everything else keeps Vite's default behaviour.
      return undefined;
    },
  },
});
