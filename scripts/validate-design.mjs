import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const clone = value => structuredClone(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    assert(Object.keys(value).every(k => /^[\x20-\x7e]+$/.test(k)), 'Object keys must be ASCII');
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  if (typeof value === 'number') assert(Number.isSafeInteger(value), 'Unsafe numeric value');
  return value;
}
const hash = value => 'sha256:' + createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (a, b) => assert.deepEqual(a, b);
const ruleKey = ref => `${ref.id}@${ref.version}`;
const sum = rows => rows.reduce((n, r) => n + r.weight, 0);

const schema = read('schemas/contracts-v1.schema.json');
const require = createRequire(import.meta.url);
const argIndex = process.argv.indexOf('--ajv-path');
let Ajv2020;
try {
  Ajv2020 = require(argIndex >= 0 ? process.argv[argIndex + 1] : 'ajv/dist/2020.js');
} catch {
  throw new Error('Ajv2020 is required. After engineering setup install ajv, or pass --ajv-path <absolute module path>.');
}
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const validateShape = ajv.compile(schema);
function shape(value) {
  assert(validateShape(value), JSON.stringify(validateShape.errors, null, 2));
}

function validateRule(rule) {
  equal(rule.definitionHash, hash(rule.definition));
  const d = rule.definition;
  assert(d.board.rows * d.board.cols <= 4096, 'Initial board resource budget exceeded');
  const positions = new Set();
  for (const tile of d.board.initialLayout) {
    assert(tile.index < d.board.rows * d.board.cols, 'Initial tile is out of range');
    assert(!positions.has(tile.index), 'Duplicate initial cell');
    positions.add(tile.index);
    assert(tile.value.length <= d.numbers.maxDigits, 'Initial tile exceeds integer budget');
  }
  for (const [weights, needed] of [[d.spawn.initialWeights, d.spawn.initialCount > positions.size], [d.spawn.weights, d.spawn.perActionCount > 0]]) {
    assert(new Set(weights.map(w => w.value)).size === weights.length, 'Duplicate weighted value');
    assert(sum(weights) <= 4294967295, 'Weight total overflow');
    if (needed) assert(sum(weights) > 0, 'Required distribution has zero weight');
  }
  for (const c of Object.values(d.skills)) assert(c.initialCharges <= c.maxCharges, 'Charges exceed maximum');
  assert(d.timer.mode === 'countdown' ? d.timer.limitMs > 0 : d.timer.limitMs === null, 'Timer configuration mismatch');
  if (d.mode === 'normal') {
    equal([d.board.rows, d.board.cols, d.spawn.initialCount, d.spawn.perActionCount], [4, 4, 2, 1]);
    equal(d.spawn.weights, [{ value: '2', weight: 9 }, { value: '4', weight: 1 }]);
    assert(Object.values(d.skills).every(s => !s.enabled), 'Classic preset enables a skill');
  }
}
function validateRng(rng) {
  const limit = 1n << 64n;
  assert(BigInt(rng.state) < limit && BigInt(rng.increment) < limit, 'RNG state overflows 64 bits');
  assert((BigInt(rng.increment) & 1n) === 1n, 'RNG increment must be odd');
}
function validateFixture(fixture) {
  const rules = new Map();
  for (const rule of fixture.rulesets) {
    validateRule(rule);
    assert(!rules.has(ruleKey(rule)), 'Duplicate rule version');
    rules.set(ruleKey(rule), rule.definition);
  }
  const states = new Map();
  for (const entry of fixture.states) {
    equal(entry.hash, hash(entry.payload));
    assert(!states.has(entry.hash), 'Duplicate state entry');
    states.set(entry.hash, entry.payload);
    const s = entry.payload, d = rules.get(ruleKey(s.ruleRef));
    assert(d, 'Missing rule reference');
    equal([s.world.board.rows, s.world.board.cols], [d.board.rows, d.board.cols]);
    equal(s.world.board.cells.length, d.board.rows * d.board.cols);
    const tiles = s.world.board.cells.flatMap(c => c.tile ? [c.tile] : []);
    assert(new Set(tiles.map(t => t.id)).size === tiles.length, 'Duplicate tile ID within a state');
    assert(tiles.every(t => t.value.length <= d.numbers.maxDigits), 'Tile integer budget exceeded');
    assert(s.world.score.length <= d.numbers.maxDigits, 'Score integer budget exceeded');
    validateRng(s.rng);
    for (const [id, skill] of Object.entries(s.ledger.skills)) {
      const c = d.skills[id];
      assert(c, 'Missing skill configuration');
      assert(c.unlimited ? skill.charges === null : Number.isSafeInteger(skill.charges) && skill.charges <= c.maxCharges, 'Invalid runtime skill charges');
    }
  }
  const nodes = new Map();
  const operations = new Set();
  for (const n of fixture.nodes) {
    assert(!nodes.has(n.id), 'Duplicate node ID'); nodes.set(n.id, n);
    assert(states.has(n.stateHash), 'Missing node state');
    if (n.operationId !== null) { assert(!operations.has(n.operationId), 'Duplicate operation ID'); operations.add(n.operationId); }
  }
  const getState = id => states.get(nodes.get(id)?.stateHash);
  const ancestors = id => {
    const seen = new Set(); let n = nodes.get(id);
    while (n?.parentId !== null) {
      assert(n && nodes.has(n.parentId), 'Missing parent node');
      assert(!seen.has(n.parentId), 'Cycle in node parents');
      seen.add(n.parentId); n = nodes.get(n.parentId);
    }
    return seen;
  };
  for (const n of fixture.nodes) {
    const s = getState(n.id), lineage = ancestors(n.id);
    assert(s.undoStack.every(id => lineage.has(id)), 'Undo stack references a non-ancestor');
    if (n.parentId === null) {
      equal(n.depth, 0); equal(n.action, null); equal(n.randomContext, null);
      assert(fixture.project.rootNodeIds.includes(n.id), 'Unlisted root'); continue;
    }
    const parent = nodes.get(n.parentId), before = getState(n.parentId);
    equal(n.matchId, parent.matchId); equal(n.depth, parent.depth + 1);
    assert(n.action && n.randomContext && n.operationId, 'Incomplete non-root transition');
    const increase = n.action.type === 'time-advance' ? 0 : 1;
    equal(s.ledger.effectiveActionCount, before.ledger.effectiveActionCount + increase);
    equal(n.randomContext.after, s.rng);
    validateRng(n.randomContext.before);
    if (n.randomContext.mode !== 'reroll') equal(n.randomContext.before, before.rng);
    if (n.action.type === 'skill' && n.action.payload.skillId === 'undo') {
      const target = n.undoTargetId;
      assert(lineage.has(target), 'Undo target must be an ancestor');
      equal(n.action.payload.targetNodeId, target);
      equal(before.undoStack.at(-1), target);
      equal(s.undoStack, before.undoStack.slice(0, -1));
      const config = rules.get(ruleKey(s.ruleRef)).skills.undo;
      const oldSkill = before.ledger.skills.undo, newSkill = s.ledger.skills.undo;
      equal(newSkill.charges, config.unlimited ? null : oldSkill.charges - 1);
      equal(newSkill.usedCount, oldSkill.usedCount + 1);
      equal(s.ruleRef, before.ruleRef);
      equal(s.rng, before.rng);
      if (!config.advanceRound) {
        equal(s.ledger.chargedTurnCount, before.ledger.chargedTurnCount);
        const expectedWorld = clone(getState(target).world);
        expectedWorld.score = (BigInt(expectedWorld.score) - BigInt(config.scoreCost)).toString();
        equal(s.world, expectedWorld);
      }
    } else if (n.action.type === 'move') {
      equal(n.undoTargetId, null);
      equal(s.undoStack, [...before.undoStack, n.parentId]);
    }
  }
  assert(nodes.has(fixture.project.activeNodeId), 'Active node is missing');
  for (const id of fixture.project.rootNodeIds) assert(nodes.get(id)?.parentId === null, 'Invalid root reference');
  equal(nodes.get('S2').stateHash, nodes.get('S2-copy').stateHash);
  assert(nodes.get('S2').id !== nodes.get('S2-copy').id, 'History nodes must stay distinct');
  assert(nodes.get('S2').stateHash !== nodes.get('S3').stateHash, 'Different random context is not the same full state');
}

const classic = read('examples/presets/classic.json');
const sandbox = read('examples/presets/sandbox.json');
const fixture = read('examples/contracts/history-and-undo.json');
for (const value of [classic, sandbox, fixture]) shape(value);
validateRule(classic); validateRule(sandbox); validateFixture(fixture);

const vector = read('examples/contracts/pcg32-vector.json');
let pcg = BigInt(vector.seededState.state);
const inc = BigInt(vector.seededState.increment), mask = (1n << 64n) - 1n;
const actual = vector.expectedHex.map(() => {
  const old = pcg; pcg = (old * 6364136223846793005n + inc) & mask;
  const x = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn), rotate = Number(old >> 59n);
  return (((x >>> rotate) | (x << ((-rotate) & 31))) >>> 0).toString(16).padStart(8, '0');
});
equal(actual, vector.expectedHex);

let rejected = 0;
function invalid(label, make, check) {
  const copy = clone(fixture); make(copy);
  assert.throws(() => check(copy), undefined, label); rejected++;
}
invalid('numeric tile value', f => { f.states[0].payload.world.board.cells[0].tile.value = 2; }, shape);
invalid('negative integer text', f => { f.states[0].payload.world.score = '-1'; }, shape);
invalid('missing parent', f => { f.nodes.find(n => n.id === 'S1').parentId = 'missing'; }, validateFixture);
invalid('corrupt state hash', f => { f.states[0].payload.world.score = '999'; }, validateFixture);
invalid('undo refunded charges', f => {
  const node = f.nodes.find(n => n.id === 'U1');
  const entry = f.states.find(e => e.hash === node.stateHash);
  entry.payload.ledger.skills.undo.charges = 3;
  entry.hash = hash(entry.payload); node.stateHash = entry.hash;
}, validateFixture);

const sourceFiles = [];
function scan(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory() && !['archive', 'node_modules', '.git', '.work', 'dist', 'test-results', 'playwright-report'].includes(entry.name)) scan(p); else if (entry.isFile() && p.endsWith('.md')) sourceFiles.push(p); } }
scan(root);
let linkCount = 0;
for (const file of sourceFiles) for (const match of fs.readFileSync(file, 'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
  const target = match[1]; if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
  assert(fs.existsSync(path.resolve(path.dirname(file), decodeURIComponent(target.split('#')[0]))), `Broken link in ${file}: ${target}`); linkCount++;
}
console.log(`PASS: 3 schema documents; ${fixture.nodes.length} nodes / ${fixture.states.length} states; exact hashes, references, undo costs, 6 RNG reference outputs; ${rejected} invalid examples rejected; ${linkCount} local links.`);
console.log('Scope: design contracts only. Run the application unit and browser suites to verify the engine, IndexedDB, ZIP and PWA.');
