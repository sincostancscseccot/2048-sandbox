import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import packageInfo from './package.json' with { type: 'json' };
import { standaloneValidation } from './scripts/standalone-validation';

export default defineConfig(({ mode }) => {
  const base = process.env.SANDBOX_BASE ?? (['android', 'standalone', 'hosted'].includes(mode) ? './' : mode === 'pages' ? '/2048-sandbox/' : '/');
  return {
  base,
  plugins: [
    react(),
    standaloneValidation(),
    { name: 'local-build-version', apply: 'build', generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ version: packageInfo.version, target: mode === 'android' ? 'android' : 'web' }) });
    } },
    VitePWA({
      registerType: 'prompt',
      disable: mode === 'standalone',
      injectRegister: mode === 'android' ? false : 'auto',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '2048 Sandbox', short_name: '2048 Sandbox', lang: 'zh-CN',
        description: '每一步都有记录的离线 2048。',
        theme_color: '#25644a', background_color: '#f5f5ef', display: 'standalone',
        start_url: base, scope: base,
        icons: [{ src: `${base}icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,woff2}'], navigateFallback: base === './' ? 'index.html' : `${base}index.html` },
    }),
  ],
  build: { cssCodeSplit: mode !== 'standalone', rolldownOptions: { output: mode === 'standalone' ? { inlineDynamicImports: true } : { codeSplitting: {
    groups: [{ name: 'validation', test: /node_modules[\\/].*(ajv|fast-uri|fast-deep-equal|json-schema-traverse|require-from-string)/ }],
  } } } },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
};
});
