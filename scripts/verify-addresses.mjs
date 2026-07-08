/**
 * M0 ground-truth script: empirically determine
 *   (a) the address convention of komet-node's `pos` (wasm-file offset vs
 *       code-section-relative), by cross-checking every trace record's opcode
 *       against a wasmparser disassembly of the exact wasm that produced it;
 *   (b) the delta between DWARF .debug_line addresses and that convention;
 *   (c) the DWARF version rustc emits for wasm32v1-none.
 *
 * Prereqs: `npm run pretest` (compiles src to out/), a debug-built adder wasm
 * (CARGO_PROFILE_RELEASE_DEBUG=true CARGO_PROFILE_RELEASE_STRIP=none
 *  stellar contract build), and komet-node available.
 *
 * Usage: node scripts/verify-addresses.mjs [--wasm <path>] [--trace-out <path>]
 */

import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}
// NOTE: the *deps* wasm is the pristine wasm-ld output. `stellar contract build`
// rewrites `release/adder.wasm` to inject contractmetav0 and that rewrite EMPTIES
// all DWARF line programs (headers survive, rows are dropped). Debugging must use
// the deps artifact.
const wasmPath = flag('--wasm', path.join(root, 'examples/adder/target/wasm32v1-none/release/deps/adder.wasm'));
const traceOut = flag('--trace-out', null);
const kometCommand = flag('--komet-node', '/home/node/.komet-node/bin/komet-node');

// ---------------------------------------------------------------------------
// 1. Wasm section walk (self-contained; the real parser lands in M1)
// ---------------------------------------------------------------------------
function readLeb(bytes, at) {
  let result = 0, shift = 0, pos = at;
  for (;;) {
    const b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, pos];
}

function parseSections(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error('not a wasm binary');
  }
  const sections = [];
  let at = 8;
  while (at < bytes.length) {
    const start = at;
    const id = bytes[at++];
    let size;
    [size, at] = readLeb(bytes, at);
    const payloadStart = at;
    const payloadEnd = at + size;
    let name;
    if (id === 0) {
      let nameLen, nameAt;
      [nameLen, nameAt] = readLeb(bytes, payloadStart);
      name = Buffer.from(bytes.slice(nameAt, nameAt + nameLen)).toString('utf8');
      sections.push({ id, name, start, payloadStart: nameAt + nameLen, payloadEnd });
    } else {
      sections.push({ id, start, payloadStart, payloadEnd });
    }
    at = payloadEnd;
  }
  return sections;
}

const wasm = new Uint8Array(readFileSync(wasmPath));
const sections = parseSections(wasm);
const code = sections.find((s) => s.id === 10);
console.log(`wasm: ${wasmPath} (${wasm.length} bytes)`);
console.log('sections:');
for (const s of sections) {
  console.log(`  id=${String(s.id).padStart(2)} ${s.name ?? ''} start=${s.start} payload=[${s.payloadStart},${s.payloadEnd})`);
}
if (!code) throw new Error('no code section');
const debugNames = ['.debug_line', '.debug_info', '.debug_abbrev', '.debug_str'];
for (const n of debugNames) {
  if (!sections.some((s) => s.name === n)) throw new Error(`missing custom section ${n}`);
}
console.log('\nAll required DWARF sections present.');

// DWARF versions: peek the version fields.
function sectionBytes(name) {
  const s = sections.find((x) => x.name === name);
  return s ? wasm.slice(s.payloadStart, s.payloadEnd) : undefined;
}
{
  const dl = sectionBytes('.debug_line');
  const dlLen = dl[0] | (dl[1] << 8) | (dl[2] << 16) | (dl[3] << 24);
  const dlVer = dl[4] | (dl[5] << 8);
  const di = sectionBytes('.debug_info');
  const diVer = di[4] | (di[5] << 8);
  if (dlLen === 0xffffffff) throw new Error('64-bit DWARF (unexpected)');
  console.log(`.debug_line unit version: ${dlVer}, .debug_info CU version: ${diVer}`);
}

// ---------------------------------------------------------------------------
// 2. Disassemble with wasmparser, offsets relative to file start
// ---------------------------------------------------------------------------
const { BinaryReader } = require(path.join(root, 'node_modules/wasmparser/dist/cjs/WasmParser.js'));
const { WasmDisassembler } = require(path.join(root, 'node_modules/wasmparser/dist/cjs/WasmDis.js'));

const reader = new BinaryReader();
reader.setData(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), 0, wasm.length);
const dis = new WasmDisassembler();
dis.addOffsets = true;
dis.disassembleChunk(reader);
const result = dis.getResult();

const instrs = [];
for (let i = 0; i < result.lines.length; i++) {
  const off = result.offsets[i];
  const inBody = result.functionBodyOffsets.some((r) => off >= r.start && off < r.end);
  if (inBody) instrs.push({ address: off, text: result.lines[i].trim() });
}
instrs.sort((a, b) => a.address - b.address);
const byAddr = new Map(instrs.map((x) => [x.address, x]));
console.log(`\ndisassembly: ${instrs.length} instructions in [${instrs[0].address}, ${instrs[instrs.length - 1].address}]`);
console.log(`functionBodyOffsets: ${JSON.stringify(result.functionBodyOffsets)}`);
console.log(`code section: start=${code.start} payloadStart=${code.payloadStart}`);

// ---------------------------------------------------------------------------
// 3. Capture a real trace via the compiled TurnkeyPipeline
// ---------------------------------------------------------------------------
const { TurnkeyPipeline } = require(path.join(root, 'out/src/pipeline/TurnkeyPipeline.js'));
const pipeline = new TurnkeyPipeline();
let records;
try {
  const resolved = await pipeline.run(
    {
      wasmPath,
      function: 'add',
      args: [
        { value: 4, type: 'u32' },
        { value: 3, type: 'u32' },
      ],
      node: { command: kometCommand, port: 8011 },
    },
    (m) => console.log(`  [pipeline] ${m}`),
  );
  records = resolved.model.records;
  if (resolved.returnValue !== undefined) console.log(`returnValue: ${resolved.returnValue}`);
} finally {
  await pipeline.dispose();
}
console.log(`\ntrace: ${records.length} records`);
if (traceOut) {
  const jsonl = records
    .map((r) => JSON.stringify({ pos: r.pos, instr: r.instr, stack: r.stack, locals: r.locals }))
    .join('\n') + '\n';
  writeFileSync(traceOut, jsonl);
  console.log(`trace written to ${traceOut}`);
}

// ---------------------------------------------------------------------------
// 4. Determine the komet `pos` convention.
//
// Discovered reality (2026-07-07, komet-node from /home/node/.komet-node):
//   - komet opcode names are K-style: ["const","i64",255], ["and","i64"],
//     ["local.get",0], ["block"], and ["unknown"] for instructions its printer
//     does not know (e.g. `if`).
//   - For records executing FUNCTION CODE, `pos` is relative to the CODE
//     SECTION PAYLOAD (first byte after the section id+size header).
//   - Records evaluating GLOBAL INITIALIZERS carry `pos` relative to the
//     GLOBALS SECTION payload — same numeric range, different section, so a
//     bare `pos` is ambiguous. Per-record validation against the static
//     disassembly (mnemonic match) is required to accept a mapping.
// ---------------------------------------------------------------------------

/** Normalize a komet instr array to a wasmparser-style mnemonic, or null for unknown. */
function normalizeKomet(instr) {
  const [op, ...rest] = instr;
  if (op === 'unknown') return null;
  // Typed ALU ops arrive as [op, type]: ["and","i64"] -> "i64.and".
  if (rest.length >= 1 && (rest[0] === 'i32' || rest[0] === 'i64' || rest[0] === 'f32' || rest[0] === 'f64')) {
    return `${rest[0]}.${op}`;
  }
  return op; // local.get, block, call, return, ...
}

const candidates = [
  { name: 'file-offset (delta 0)', delta: 0 },
  { name: 'code-section-start-relative', delta: code.start },
  { name: 'code-payload-relative', delta: code.payloadStart },
];
console.log('\nkomet pos convention check (mnemonic match at pos+delta; "unknown" counts as unverifiable):');
let posConvention = null;
for (const c of candidates) {
  let match = 0, miss = 0, unverifiable = 0;
  const misses = [];
  for (const r of records) {
    if (r.pos === null) continue;
    const inst = byAddr.get(r.pos + c.delta);
    const want = normalizeKomet(r.instr);
    if (want === null) {
      if (inst) unverifiable++; else { miss++; misses.push(`pos=${r.pos} unknown, no instr @${r.pos + c.delta}`); }
      continue;
    }
    const mnemonic = inst ? inst.text.split(/[\s(]/)[0] : null;
    if (mnemonic === want) match++;
    else {
      miss++;
      if (misses.length < 4) misses.push(`pos=${r.pos} trace=${want} disasm@${r.pos + c.delta}=${inst ? inst.text : '<none>'}`);
    }
  }
  console.log(`  ${c.name}: ${match} match, ${miss} miss, ${unverifiable} unverifiable${misses.length ? '  e.g. ' + misses.join(' | ') : ''}`);
  // The best convention maximizes matches; global-initializer records are
  // EXPECTED to miss (their pos is in the globals section's address space).
  if (!posConvention || match > posConvention.match) posConvention = { ...c, match, miss };
}
console.log(`==> best komet pos convention: ${posConvention.name} (${posConvention.match} matches; misses are global-init records)`);

// Show that the misses are exactly the globals-section initializers.
const globals = sections.find((s) => s.id === 6);
if (globals) {
  console.log('\nglobal-initializer hypothesis (miss records vs globals section payload):');
  for (const r of records) {
    if (r.pos === null) continue;
    const inst = byAddr.get(r.pos + posConvention.delta);
    const want = normalizeKomet(r.instr);
    if (want !== null && (!inst || inst.text.split(/[\s(]/)[0] !== want)) {
      const fileOff = globals.payloadStart + r.pos;
      const byte = wasm[fileOff];
      const looksConst = byte === 0x41 && want === 'i32.const';
      console.log(`  pos=${r.pos} ${JSON.stringify(r.instr)} -> globals payload+${r.pos} = file ${fileOff}, byte 0x${byte.toString(16)} ${looksConst ? '= i32.const opcode ✓' : ''}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Determine the DWARF delta: decode .debug_line addresses (throwaway v4/v5
//    line-program walk, addresses only) and check which delta lands them on
//    instruction boundaries.
// ---------------------------------------------------------------------------
function decodeLineAddresses(dl) {
  // Minimal state machine: we only track `address` at each emitted row.
  const addrs = [];
  let at = 0;
  const u16 = (p) => dl[p] | (dl[p + 1] << 8);
  const u32 = (p) => (dl[p] | (dl[p + 1] << 8) | (dl[p + 2] << 16) | (dl[p + 3] << 24)) >>> 0;
  while (at < dl.length) {
    const unitLen = u32(at);
    const unitEnd = at + 4 + unitLen;
    const version = u16(at + 4);
    let p = at + 6;
    if (version === 5) p += 2; // address_size, segment_selector_size
    const headerLen = u32(p);
    p += 4;
    const minInstLen = dl[p];
    const opcodeBase = dl[p + (version >= 4 ? 3 : 2) + 1 - 1]; // min_inst, max_ops(v4+), default_is_stmt, line_base, line_range, opcode_base
    // layout: min_inst(1) [max_ops(1) v>=4] default_is_stmt(1) line_base(1,signed) line_range(1) opcode_base(1)
    const maxOpsOffset = version >= 4 ? 1 : 0;
    const lineRange = dl[p + 1 + maxOpsOffset + 2];
    const lineBase = (dl[p + 1 + maxOpsOffset + 1] << 24) >> 24;
    const opBase = dl[p + 1 + maxOpsOffset + 3];
    const stdLens = [];
    let q = p + 1 + maxOpsOffset + 4;
    for (let i = 1; i < opBase; i++) stdLens.push(dl[q++]);
    let program = p + headerLen; // program starts after header_length bytes
    let address = 0;
    const emit = () => addrs.push(address);
    while (program < unitEnd) {
      const op = dl[program++];
      if (op === 0) {
        // extended
        let len; [len, program] = readLeb(dl, program);
        const sub = dl[program];
        if (sub === 2 /* DW_LNE_set_address */) {
          address = u32(program + 1); // 4-byte addresses on wasm32
        } else if (sub === 1 /* end_sequence */) {
          emit();
          address = 0;
        }
        program += len;
      } else if (op < opBase) {
        switch (op) {
          case 1: emit(); break;                                   // copy
          case 2: { let adv; [adv, program] = readLeb(dl, program); address += adv * minInstLen; break; } // advance_pc
          case 3: { // advance_line (SLEB, skip)
            while (dl[program++] & 0x80);
            break;
          }
          case 8: { const adj = 255 - opBase; address += Math.floor(adj / lineRange) * minInstLen; break; } // const_add_pc
          case 9: address += u16(program); program += 2; break;    // fixed_advance_pc
          default: {
            for (let i = 0; i < stdLens[op - 1]; i++) { let junk; [junk, program] = readLeb(dl, program); }
          }
        }
      } else {
        const adj = op - opBase;
        address += Math.floor(adj / lineRange) * minInstLen;
        emit();
      }
    }
    at = unitEnd;
    void lineBase; void opcodeBase;
  }
  return addrs;
}

const dwarfAddrs = decodeLineAddresses(sectionBytes('.debug_line'));
console.log(`\n.debug_line: ${dwarfAddrs.length} rows decoded, addr range [${Math.min(...dwarfAddrs)}, ${Math.max(...dwarfAddrs)}]`);
console.log('DWARF delta check (rows landing on instruction boundaries, excluding end_sequence rows):');
for (const c of candidates) {
  let hit = 0, miss = 0;
  for (const a of dwarfAddrs) {
    if (byAddr.has(a + c.delta)) hit++;
    else miss++;
  }
  console.log(`  dwarfAddr + ${c.delta} (${c.name}): ${hit} on-boundary, ${miss} off`);
}
console.log('\n(end_sequence rows point one-past-the-last-instruction, so a small "off" count is expected;');
console.log(' the correct delta is the one with the overwhelming majority on-boundary.)');
