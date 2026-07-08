/**
 * Capture a komet-node execution trace for an arbitrary contract function and
 * write it as JSONL — the generalized fixture-capture step behind
 * make-fixtures.sh (verify-addresses.mjs hardcodes adder's add(4,3); this
 * script parameterizes contract, function, and arguments).
 *
 * Prereqs: `npm run pretest` (compiles src to out/), a built wasm.
 *
 * Usage:
 *   node scripts/capture-trace.mjs --wasm <path> --function <name> \
 *     [--args-json '[{"value":3,"type":"u32"}]'] [--trace-out <path>] \
 *     [--komet-node <cmd>] [--port <n>]
 */
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const wasmPath = flag('--wasm', null);
const fn = flag('--function', null);
if (!wasmPath || !fn) {
  console.error('required: --wasm <path> --function <name>');
  process.exit(2);
}
const argsJson = JSON.parse(flag('--args-json', '[]'));
const traceOut = flag('--trace-out', null);
const kometCommand = flag('--komet-node', '/home/node/.komet-node/bin/komet-node');
const port = Number(flag('--port', '8012'));

const { TurnkeyPipeline } = require(path.join(root, 'out/src/pipeline/TurnkeyPipeline.js'));
const pipeline = new TurnkeyPipeline();
let records;
try {
  const resolved = await pipeline.run(
    {
      wasmPath,
      function: fn,
      args: argsJson,
      node: { command: kometCommand, port },
    },
    (m) => console.log(`  [pipeline] ${m}`),
  );
  records = resolved.model.records;
  if (resolved.returnValue !== undefined) console.log(`returnValue: ${resolved.returnValue}`);
} finally {
  await pipeline.dispose();
}
console.log(`trace: ${records.length} records`);
if (traceOut) {
  const jsonl =
    records
      .map((r) => JSON.stringify({ pos: r.pos, instr: r.instr, stack: r.stack, locals: r.locals }))
      .join('\n') + '\n';
  writeFileSync(traceOut, jsonl);
  console.log(`trace written to ${traceOut}`);
}
