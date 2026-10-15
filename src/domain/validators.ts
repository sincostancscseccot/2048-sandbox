import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../../schemas/contracts-v1.schema.json' with { type: 'json' };
import archiveSchema from '../../schemas/archive-v1.schema.json' with { type: 'json' };

// Node tools and development use the same schemas directly. Production builds
// replace this module with static functions so no Function constructor is needed.
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
ajv.addSchema(archiveSchema);
const validators = Object.fromEntries(['GameState', 'HistoryNode', 'Project', 'RuleSetVersion', 'RuleDefinition', 'Action'].map(name =>
  [name, ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` })]));
for (const name of ['Manifest', 'LibrarySnapshot', 'ProjectPayload', 'NodeIndex', 'Delta']) {
  validators[name] = ajv.compile({ $ref: `${archiveSchema.$id}#/$defs/${name}` });
}
export default validators;
