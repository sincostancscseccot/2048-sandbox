import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
try {
  const { sandboxPresets } = await server.ssrLoadModule('/src/presets/catalog.ts');
  const { createCustomRule } = await server.ssrLoadModule('/src/presets/rules.ts');
  const output = resolve(root, 'examples/presets/m6'); await mkdir(output, { recursive: true });
  for (const preset of sandboxPresets) {
    const rule = await createCustomRule(preset.name, preset.definition()); rule.id = `preset-${preset.id}`;
    await writeFile(resolve(output, `${preset.id}.json`), JSON.stringify(rule, null, 2) + '\n');
    console.log(`Exported ${preset.id}: ${rule.definitionHash}`);
  }
} finally { await server.close(); }
