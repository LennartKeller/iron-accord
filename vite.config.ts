import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  publicDir: '../data',
  server: {
    host: true,
    fs: { allow: ['..'] },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
