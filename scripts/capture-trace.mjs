/**
 * Capture a komet-node execution trace as JSONL — the fixture-capture step
 * behind make-fixtures.sh.
 *
 * The records are written EXACTLY as komet-node returned them, not
 * re-serialized from parsed ones, so a fixture keeps everything the adapter's
 * parser reads: the `kind` tag, the Soroban VM event payloads, per-step memory
 * and globals. To get at them the script runs the real pipeline (spawn ->
 * deploy -> invoke -> traceTransaction) with a KometClient that stashes the raw
 * `traceTransaction` result on its way through.
 *
 * Prereqs: `npm run pretest` (compiles src/ to out/), a built wasm, komet-node.
 *
 * Usage:
 *   node scripts/capture-trace.mjs --wasm <path> --function <name> \
 *     [--args-json '{"by":5}'] [--trace-out <path>] \
 *     [--komet-node <cmd>] [--port <n>]
 */
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (m) => require(path.join(root, 'out/src', m));

const { KometClient } = out('komet/KometClient.js');
const { KometProcess } = out('komet/KometProcess.js');
const { SequenceRunner } = out('pipeline/SequenceRunner.js');
const { normalizeConfig } = out('pipeline/config.js');

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
const args = JSON.parse(flag('--args-json', '{}'));
const traceOut = flag('--trace-out', null);
const kometCommand = flag('--komet-node', 'komet-node');
const port = Number(flag('--port', '8012'));

/** A client that keeps the raw trace records the node sent. */
class CapturingClient extends KometClient {
  raw = [];
  async traceTransaction(hash) {
    this.raw = await super.traceTransaction(hash);
    return this.raw;
  }
}

const config = normalizeConfig({
  transactions: [
    { kind: 'deploy', id: 'contract', wasm: wasmPath },
    { kind: 'invoke', contract: 'contract', function: fn, args },
  ],
});

const node = new KometProcess({ command: kometCommand, host: 'localhost', port });
const client = new CapturingClient({ host: 'localhost', port });
const report = (m) => console.log(`  [pipeline] ${m}`);

node.start(report);
try {
  console.log(`Waiting for komet-node at ${client.url} ...`);
  await client.waitForHealthy(60_000);
  const resolved = await new SequenceRunner(client).run(config, {}, report);
  const returnValue = resolved.model.returnValue;
  if (returnValue !== undefined) {
    console.log(`returnValue: ${returnValue}`);
  }
} finally {
  await node.stop();
}

console.log(`trace: ${client.raw.length} records`);
if (traceOut) {
  writeFileSync(traceOut, client.raw.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`trace written to ${traceOut}`);
}
