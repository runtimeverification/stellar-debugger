/**
 * Check the address convention a captured fixture pair rests on.
 *
 * The whole debugger assumes ONE address space: komet-node's `pos` for function
 * code, the DWARF `.debug_line` addresses, and the static disassembly are all
 * offsets relative to the CODE SECTION PAYLOAD, with no delta between them.
 * That is an empirical property of the toolchain, so this script re-derives it
 * from a real (wasm, trace) pair rather than trusting it — run it whenever the
 * fixtures are regenerated, or after a komet-node or rustc upgrade.
 *
 * It reports, for each candidate convention (file offset / section start /
 * section payload):
 *   - how many trace records' mnemonics agree with the disassembly at `pos + delta`;
 *   - how many `.debug_line` rows land on an instruction boundary at `addr + delta`.
 * The payload-relative candidate must win both, overwhelmingly.
 *
 * Misses are expected and explained: komet prints instructions its decoder does
 * not know as `unknown` (unverifiable), and records evaluating GLOBAL
 * INITIALIZERS carry a `pos` in the *globals* section's address space — the
 * ambiguity that forces per-record mnemonic validation in the adapter
 * (src/debugAdapter/artifacts.ts). Those are listed separately.
 *
 * Everything is read through the project's own parsers (out/src), so this script
 * cannot drift from what the debugger actually does.
 *
 * Prereqs: `npm run pretest` (compiles src/ to out/).
 *
 * Usage: node scripts/verify-addresses.mjs --wasm <path> --trace <path.jsonl>
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (m) => require(path.join(root, 'out/src', m));

const { parseWasmSections } = out('wasm/sections.js');
const { Disassembly } = out('wasm/Disassembly.js');
const { DwarfLineTable } = out('dwarf/LineTable.js');
const { parseTraceJsonl } = out('komet/trace.js');
const { normalizeMnemonic } = out('komet/mnemonics.js');

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

// NOTE: the *deps* wasm is the pristine wasm-ld output. `stellar contract build`
// rewrites `release/<name>.wasm` to inject contractmetav0, and that rewrite
// EMPTIES all DWARF line programs (headers survive, rows are dropped). Source
// mapping must use the deps artifact.
const wasmPath = flag('--wasm');
const tracePath = flag('--trace');
if (!wasmPath || !tracePath) {
  console.error('required: --wasm <path> --trace <path.jsonl>');
  process.exit(2);
}

const wasm = new Uint8Array(readFileSync(wasmPath));
const { sections, codeSection } = parseWasmSections(wasm);
if (!codeSection) {
  throw new Error('wasm module has no code section');
}

console.log(`wasm: ${wasmPath} (${wasm.length} bytes)`);
for (const s of sections) {
  console.log(
    `  id=${String(s.id).padStart(2)} ${s.name ?? ''} start=${s.start} payload=[${s.payloadStart},${s.payloadEnd})`,
  );
}
for (const name of ['.debug_line', '.debug_info', '.debug_abbrev', '.debug_str']) {
  if (!sections.some((s) => s.name === name)) {
    throw new Error(`missing custom section ${name} — was the wasm built with debug info?`);
  }
}
console.log('\nAll required DWARF sections present.');

// Disassembly.fromWasm already reports CODE-PAYLOAD-relative addresses, so a
// candidate delta is applied to the trace/DWARF side of the comparison.
const disassembly = Disassembly.fromWasm(wasm);
const instructions = disassembly.instructions;
const byAddress = new Map(instructions.map((i) => [i.address, i]));
console.log(
  `\ndisassembly: ${instructions.length} instructions in ` +
    `[${instructions[0].address}, ${instructions[instructions.length - 1].address}]`,
);
console.log(`function bodies: ${JSON.stringify(disassembly.functionRanges)}`);

const records = parseTraceJsonl(readFileSync(tracePath, 'utf8'));
console.log(`trace: ${tracePath} (${records.length} records)`);

// A `pos` is stated relative to some section; the candidate says which, as the
// offset that must be SUBTRACTED to reach the code-payload space.
const candidates = [
  { name: 'code-payload-relative', delta: 0 },
  { name: 'code-section-start-relative', delta: codeSection.start - codeSection.payloadStart },
  { name: 'file-offset', delta: -codeSection.payloadStart },
];

console.log('\nkomet `pos` convention (mnemonic agreement at pos + delta):');
let best = null;
for (const candidate of candidates) {
  let match = 0;
  let miss = 0;
  let unverifiable = 0;
  for (const record of records) {
    if (record.pos === null) {
      continue;
    }
    const instruction = byAddress.get(record.pos + candidate.delta);
    const want = normalizeMnemonic(record.instr);
    if (want === null) {
      // komet could not decode the opcode: nothing to compare against.
      instruction ? unverifiable++ : miss++;
      continue;
    }
    if (instruction && instruction.text.split(/\s+/, 1)[0] === want) {
      match++;
    } else {
      miss++;
    }
  }
  console.log(`  ${candidate.name} (delta ${candidate.delta}): ${match} match, ${miss} miss, ${unverifiable} unverifiable`);
  if (!best || match > best.match) {
    best = { ...candidate, match };
  }
}
console.log(`==> best: ${best.name}`);
if (best.delta !== 0) {
  console.error('MISMATCH: the trace is NOT code-payload-relative — the adapter assumes it is.');
  process.exitCode = 1;
}

// The remaining misses should be exactly the global-initializer records, whose
// `pos` indexes the globals section's payload instead.
const globals = sections.find((s) => s.id === 6);
const misses = records.filter((r) => {
  if (r.pos === null) {
    return false;
  }
  const want = normalizeMnemonic(r.instr);
  const instruction = byAddress.get(r.pos);
  return want !== null && (!instruction || instruction.text.split(/\s+/, 1)[0] !== want);
});
if (misses.length > 0) {
  console.log(`\n${misses.length} record(s) do not match the code section; global-initializer hypothesis:`);
  for (const record of misses) {
    const line = `  pos=${record.pos} ${JSON.stringify(record.instr)}`;
    if (!globals) {
      console.log(`${line} — no globals section to attribute it to`);
      continue;
    }
    const fileOffset = globals.payloadStart + record.pos;
    console.log(`${line} -> globals payload+${record.pos} = file ${fileOffset}, byte 0x${wasm[fileOffset].toString(16)}`);
  }
}

// DWARF rows must land on instruction boundaries in the same space. Excluded:
// end_sequence rows (they point one past a sequence's last instruction), and
// rows addressing code beyond this code section — a linked wasm keeps the line
// programs of dead-stripped library code, whose addresses describe nothing here.
// The debugger is unaffected by that tail: it only ever looks up a `pos`, and
// every real `pos` is inside the section.
const table = DwarfLineTable.fromWasm(wasm);
if (table === null) {
  throw new Error('no DWARF line table in the wasm');
}
const lastAddress = instructions[instructions.length - 1].address;
const allRows = table.entries.filter((e) => !e.endSequence);
const rows = allRows.filter((row) => row.address <= lastAddress);
console.log(
  `\n.debug_line: ${allRows.length} non-end_sequence rows, ${rows.length} of them within ` +
    `the code section (<= ${lastAddress}); ${allRows.length - rows.length} describe stripped code`,
);
console.log('DWARF address convention (in-section rows landing on an instruction boundary at addr + delta):');
for (const candidate of candidates) {
  const onBoundary = rows.filter((row) => byAddress.has(row.address + candidate.delta)).length;
  const percent = rows.length === 0 ? 0 : Math.round((onBoundary / rows.length) * 100);
  console.log(
    `  ${candidate.name} (delta ${candidate.delta}): ${onBoundary}/${rows.length} on-boundary (${percent}%)`,
  );
}
console.log('\nThe correct convention is the one with the overwhelming majority on-boundary.');
