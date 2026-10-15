import type { Plugin } from 'vite';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import contracts from '../schemas/contracts-v1.schema.json' with { type: 'json' };
import archive from '../schemas/archive-v1.schema.json' with { type: 'json' };

export function standaloneValidation(): Plugin {
  const id = '\0sandbox-static-validators';
  return {
    name: 'sandbox-static-validators', apply: 'build', enforce: 'pre',
    resolveId(source, importer) {
      if (source === './validators' && importer?.replaceAll('\\', '/').endsWith('/src/domain/validation.ts')) return id;
    },
    load(moduleId) {
      if (moduleId !== id) return;
      const ajv = new Ajv2020({ strict: true, allErrors: true, code: { source: true, esm: true } });
      ajv.addSchema(contracts); ajv.addSchema(archive);
      const refs = Object.fromEntries([
        ...['GameState', 'HistoryNode', 'Project', 'RuleSetVersion', 'RuleDefinition', 'Action'].map(name => [name, `${contracts.$id}#/$defs/${name}`]),
        ...['Manifest', 'LibrarySnapshot', 'ProjectPayload', 'NodeIndex', 'Delta'].map(name => [name, `${archive.$id}#/$defs/${name}`]),
      ]);
      const imports = new Map<string, string>();
      let code = standaloneCode(ajv, refs);
      // Ajv's standalone ESM output references its small CJS runtime helpers.
      // Express those references as imports so Vite can bundle them for browsers.
      code = code.replace(/require\("(ajv\/dist\/runtime\/[^"\\]+)"\)\.default/g, (_match, path: string) => {
        if (!imports.has(path)) imports.set(path, `runtime${imports.size}`);
        return imports.get(path)!;
      });
      if (/\brequire\s*\(/.test(code)) throw new Error('Unexpected runtime dependency in standalone validators');
      const prelude = [...imports].map(([path, name]) => `import ${name} from ${JSON.stringify(path + '.js')};`).join('\n');
      return `${prelude}\n${code}\nexport default {${Object.keys(refs).join(',')}};`;
    },
  };
}
