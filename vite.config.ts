import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under
// https://<user>.github.io/<repo>/ as well as a custom domain / local preview.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});
