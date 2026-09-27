import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The studio imports the simulation engine from the workspace SDK build.
// Run `npm run build` inside ../sdk first (sdk/dist must exist).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sdk': path.resolve(__dirname, '../sdk/dist/index.js'),
    },
  },
});
