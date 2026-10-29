import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  base: './',
  plugins: [
    react(),
    {
      name: 'workbench-development-csp',
      transformIndexHtml(html) {
        return command === 'serve'
          ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
          : html;
      },
    },
  ],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
}));
