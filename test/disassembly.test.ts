import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Disassembly, WasmInstruction } from '../src/wasm/Disassembly';
import { normalizeMnemonic } from '../src/komet/mnemonics';
import { parseWasmSections } from '../src/wasm/sections';
import { parseTraceJsonl, TraceRecord } from '../src/komet/trace';
import { TraceModel } from '../src/debugAdapter/TraceModel';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');

/** The instruction at exactly `addr` (a code offset), or undefined. */
function instructionAt(dis: Disassembly, addr: number): WasmInstruction | undefined {
  return dis.instructions.find((i: WasmInstruction) => i.address === addr);
}

/** First whitespace-separated token of an instruction's text (its mnemonic). */
function mnemonicOf(instr: WasmInstruction): string {
  return instr.text.split(/\s+/)[0];
}

function assertStrictlyIncreasingAddresses(instructions: readonly WasmInstruction[]): void {
  for (let i = 1; i < instructions.length; i++) {
    assert.ok(
      instructions[i].address > instructions[i - 1].address,
      `addresses not strictly increasing at index ${i}: ` +
        `${instructions[i - 1].address} then ${instructions[i].address}`,
    );
  }
}

describe('wasm/Disassembly', () => {
  describe('fromWasm on the adder debug fixture', () => {
    let wasmBytes: Uint8Array;
    let dis: Disassembly;
    let codeSize: number;

    before(async () => {
      wasmBytes = await fs.readFile(ADDER_WASM);
      const parsed = parseWasmSections(wasmBytes);
      assert.ok(parsed.codeSection, 'fixture must have a code section');
      codeSize = parsed.codeSection.payloadEnd - parsed.codeSection.payloadStart;
      dis = Disassembly.fromWasm(wasmBytes);
    });

    it('produces instructions', () => {
      assert.ok(dis.instructions.length > 0, 'expected at least one instruction');
    });

    it('addresses are strictly increasing code offsets within the code payload', () => {
      assertStrictlyIncreasingAddresses(dis.instructions);
      for (const instr of dis.instructions) {
        assert.ok(
          instr.address >= 0 && instr.address < codeSize,
          `address ${instr.address} outside [0, ${codeSize})`,
        );
      }
    });

    it('decodes i32.add at code offset 45', () => {
      const instr = instructionAt(dis, 45);
      assert.ok(instr, 'expected an instruction at code offset 45');
      assert.ok(
        instr.text.startsWith('i32.add'),
        `expected text starting with 'i32.add', got '${instr.text}'`,
      );
    });

    it('decodes i64.const 255 at code offset 11', () => {
      const instr = instructionAt(dis, 11);
      assert.ok(instr, 'expected an instruction at code offset 11');
      assert.strictEqual(instr.text, 'i64.const 255');
    });

    it('decodes block at code offset 5', () => {
      const instr = instructionAt(dis, 5);
      assert.ok(instr, 'expected an instruction at code offset 5');
      assert.strictEqual(mnemonicOf(instr), 'block');
    });

    it('bytes, when present, are non-empty and span to the next instruction', () => {
      for (const instr of dis.instructions) {
        if (instr.bytes !== undefined) {
          assert.ok(instr.bytes.length > 0, `empty bytes at address ${instr.address}`);
        }
      }
      const [first, second] = dis.instructions;
      assert.ok(first.bytes, 'expected raw bytes for the first instruction');
      assert.strictEqual(first.bytes.length, second.address - first.address);
    });

    // The load-bearing invariant behind per-record validation: a trace record's
    // pos is only trusted if the static disassembly agrees on the mnemonic at
    // that code offset. The fixture's global-initializer records (pos relative
    // to the globals-section payload, a different address space) must fail it.
    it('cross-validates the matched trace fixture per record', async () => {
      const records = parseTraceJsonl(await fs.readFile(ADDER_TRACE, 'utf8'));

      let validated = 0;
      const failed: TraceRecord[] = [];
      for (const record of records) {
        if (record.pos === null) {
          continue;
        }
        const mnemonic = normalizeMnemonic(record.instr);
        if (mnemonic === null) {
          continue;
        }
        const instr = instructionAt(dis, record.pos);
        if (instr !== undefined && mnemonicOf(instr) === mnemonic) {
          validated++;
        } else {
          failed.push(record);
        }
      }
      assert.ok(validated >= 30, `expected >= 30 validated records, got ${validated}`);

      const globalInits = records.filter(
        (r) => r.instr[0] === 'const' && r.instr[1] === 'i32' && r.instr[2] === 1048576,
      );
      assert.strictEqual(globalInits.length, 3, 'fixture precondition: three global-initializer records');
      assert.deepStrictEqual(
        globalInits.map((r) => r.pos),
        [3, 11, 19],
        'fixture precondition: global initializers at pos 3, 11, 19',
      );
      for (const r of globalInits) {
        assert.ok(
          failed.includes(r),
          `global-initializer record at pos ${r.pos} must NOT validate`,
        );
      }
      // pos 3 and 19 fail because no instruction starts at those code offsets;
      // pos 11 fails on mnemonic mismatch against the i64.const that lives there.
      assert.strictEqual(instructionAt(dis, 3), undefined);
      assert.strictEqual(instructionAt(dis, 19), undefined);
      const at11 = instructionAt(dis, 11);
      assert.ok(at11);
      assert.notStrictEqual(mnemonicOf(at11), 'i32.const');
    });

    describe('indexForAddress', () => {
      it('returns the instruction on an exact boundary hit', () => {
        const i = dis.indexForAddress(45);
        assert.ok(i >= 0);
        assert.strictEqual(dis.instructions[i].address, 45);
      });

      it('snaps a mid-instruction address to the containing instruction', () => {
        // The i64.const at 11 is 3 bytes long; the next instruction is at 14.
        const at11 = dis.indexForAddress(11);
        assert.strictEqual(dis.indexForAddress(12), at11);
        assert.strictEqual(dis.indexForAddress(13), at11);
        assert.strictEqual(dis.instructions[at11].address, 11);
      });

      it('returns -1 below the first instruction', () => {
        const first = dis.instructions[0].address;
        assert.ok(first > 0, 'fixture precondition: first instruction not at offset 0');
        assert.strictEqual(dis.indexForAddress(0), -1);
        assert.strictEqual(dis.indexForAddress(first - 1), -1);
      });

      it('returns the last index far past the last instruction', () => {
        const last = dis.instructions.length - 1;
        assert.strictEqual(dis.indexForAddress(dis.instructions[last].address + 10000), last);
      });
    });
  });

  describe('fromTrace on the adder trace fixture', () => {
    let records: TraceRecord[];
    let dis: Disassembly;

    before(async () => {
      records = parseTraceJsonl(await fs.readFile(ADDER_TRACE, 'utf8'));
      dis = Disassembly.fromTrace(new TraceModel(records));
    });

    it('has strictly increasing addresses', () => {
      assert.ok(dis.instructions.length > 0);
      assertStrictlyIncreasingAddresses(dis.instructions);
    });

    it('contains one instruction per unique non-null pos', () => {
      const uniquePos = new Set(
        records.map((r) => r.pos).filter((p): p is number => p !== null),
      );
      assert.strictEqual(dis.instructions.length, uniquePos.size);
      for (const instr of dis.instructions) {
        assert.ok(uniquePos.has(instr.address), `unexpected address ${instr.address}`);
      }
    });

    it('renders instruction texts via the mnemonic normalizer', () => {
      const add = instructionAt(dis, 45);
      assert.ok(add);
      assert.strictEqual(add.text, 'i32.add');
      // ['const','i64',255] executes at pos 22.
      const i64const = instructionAt(dis, 22);
      assert.ok(i64const);
      assert.strictEqual(i64const.text, 'i64.const 255');
    });

    it('collapses duplicate pos values, first record winning', () => {
      // pos 11 is carried both by a global-initializer record (i32.const, first)
      // and a code record (i64.const) — positions from different address spaces
      // can collide, and fromTrace keeps the first.
      const at11 = dis.instructions.filter((i: WasmInstruction) => i.address === 11);
      assert.strictEqual(at11.length, 1);
      assert.strictEqual(at11[0].text, 'i32.const 1048576');
    });

    it('has no raw bytes (unknown without the wasm)', () => {
      for (const instr of dis.instructions) {
        assert.strictEqual(instr.bytes, undefined);
      }
    });
  });

  describe('empty disassembly', () => {
    it('fromTrace of an empty model has no instructions and indexForAddress is -1', () => {
      const dis = Disassembly.fromTrace(new TraceModel([]));
      assert.strictEqual(dis.instructions.length, 0);
      assert.strictEqual(dis.indexForAddress(0), -1);
      assert.strictEqual(dis.indexForAddress(1000), -1);
    });
  });
});
