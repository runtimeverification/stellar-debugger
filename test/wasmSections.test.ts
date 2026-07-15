import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  parseWasmSections,
  stripCustomSections,
  stripDebugSections,
  WasmFormatError,
} from '../src/wasm/sections';
import { WASM_HEADER, customSection, section, wasmModule } from './support/wasmBytes';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const FIXTURE = path.join(FIXTURES, 'sample_contract.wasm');
// A debug build (has .debug_abbrev/.debug_info/.debug_line/.debug_ranges/.debug_str
// alongside contractspecv0/contractmetav0/contractenvmetav0/name/producers/... customs).
const INCREMENT_DEBUG = path.join(FIXTURES, 'increment-debug.wasm');
// A release build with NO .debug* sections at all.
const NO_DEBUG = FIXTURE;

/** Content bytes of the id-10 code section, as a plain array for deepStrictEqual. */
function codePayload(bytes: Uint8Array): number[] {
  const code = parseWasmSections(bytes).codeSection;
  assert.ok(code, 'expected a code section');
  return Array.from(bytes.subarray(code.payloadStart, code.payloadEnd));
}

describe('parseWasmSections', () => {
  it('parses a minimal module (magic + version only) to zero sections', () => {
    const parsed = parseWasmSections(Uint8Array.from(WASM_HEADER));
    assert.deepStrictEqual(parsed.sections, []);
    assert.strictEqual(parsed.codeSection, undefined);
    assert.strictEqual(parsed.customSection('anything'), undefined);
  });

  describe('a module with a code section and two custom sections (duplicate name)', () => {
    // Layout (byte offsets):
    //   0.. 8  header
    //   8..13  code section:  id=10 @8, size=3 @9, payload [1,2,3] @10..13
    //  13..21  custom 'dup':  id=0 @13, size=6 @14, nameLen=3 @15,
    //                         name @16..19, content [0xaa,0xbb] @19..21
    //  21..28  custom 'dup':  id=0 @21, size=5 @22, nameLen=3 @23,
    //                         name @24..27, content [0xcc] @27..28
    const bytes = wasmModule(
      section(10, [1, 2, 3]),
      customSection('dup', [0xaa, 0xbb]),
      customSection('dup', [0xcc]),
    );

    it('walks all sections with correct offsets', () => {
      const parsed = parseWasmSections(bytes);
      assert.strictEqual(parsed.sections.length, 3);

      const code = parsed.sections[0];
      assert.strictEqual(code.id, 10);
      assert.strictEqual(code.name, undefined);
      assert.strictEqual(code.start, 8);
      assert.strictEqual(code.payloadStart, 10);
      assert.strictEqual(code.payloadEnd, 13);

      const first = parsed.sections[1];
      assert.strictEqual(first.id, 0);
      assert.strictEqual(first.name, 'dup');
      assert.strictEqual(first.start, 13);
      // For custom sections payloadStart skips the name field.
      assert.strictEqual(first.payloadStart, 19);
      assert.strictEqual(first.payloadEnd, 21);

      const second = parsed.sections[2];
      assert.strictEqual(second.id, 0);
      assert.strictEqual(second.name, 'dup');
      assert.strictEqual(second.start, 21);
      assert.strictEqual(second.payloadStart, 27);
      assert.strictEqual(second.payloadEnd, 28);
    });

    it('exposes the id-10 section as codeSection', () => {
      const parsed = parseWasmSections(bytes);
      assert.strictEqual(parsed.codeSection, parsed.sections[0]);
    });

    it('customSection() returns the content slice of the FIRST match', () => {
      const parsed = parseWasmSections(bytes);
      const content = parsed.customSection('dup');
      assert.ok(content, 'expected a content slice for "dup"');
      assert.deepStrictEqual(Array.from(content), [0xaa, 0xbb]);
    });

    it('customSection() returns undefined for an absent name', () => {
      const parsed = parseWasmSections(bytes);
      assert.strictEqual(parsed.customSection('absent'), undefined);
    });
  });

  it('decodes multi-byte ULEB128 section sizes', () => {
    // Payload of 130 bytes forces a two-byte size ULEB (0x82 0x01).
    const payload = new Array<number>(130).fill(7);
    const parsed = parseWasmSections(wasmModule(section(11, payload)));
    assert.strictEqual(parsed.sections.length, 1);
    const s = parsed.sections[0];
    assert.strictEqual(s.start, 8);
    assert.strictEqual(s.payloadStart, 11);
    assert.strictEqual(s.payloadEnd, 141);
  });

  it('rejects bad magic', () => {
    const bytes = Uint8Array.from([0x00, 0x61, 0x73, 0x00, 0x01, 0x00, 0x00, 0x00]);
    assert.throws(() => parseWasmSections(bytes), WasmFormatError);
  });

  it('rejects an unsupported version', () => {
    const bytes = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
    assert.throws(() => parseWasmSections(bytes), WasmFormatError);
  });

  it('rejects a buffer shorter than the header', () => {
    assert.throws(() => parseWasmSections(Uint8Array.from([0x00, 0x61, 0x73])), WasmFormatError);
  });

  it('rejects a truncated section size (id byte at EOF)', () => {
    const bytes = Uint8Array.from([...WASM_HEADER, 10]);
    assert.throws(() => parseWasmSections(bytes), WasmFormatError);
  });

  it('rejects a size ULEB that runs off the buffer', () => {
    // Continuation bit set on the last byte of the file.
    const bytes = Uint8Array.from([...WASM_HEADER, 10, 0x80]);
    assert.throws(() => parseWasmSections(bytes), WasmFormatError);
  });

  it('rejects a section extending past end of file', () => {
    // Declared payload size 5, but only one payload byte present.
    const bytes = Uint8Array.from([...WASM_HEADER, 10, 5, 0]);
    assert.throws(() => parseWasmSections(bytes), WasmFormatError);
  });

  it('rejects a ULEB128 longer than 5 bytes', () => {
    const bytes = Uint8Array.from([...WASM_HEADER, 10, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
    assert.throws(() => parseWasmSections(bytes), WasmFormatError);
  });

  it('parses the committed real contract fixture', async () => {
    const bytes = await fs.readFile(FIXTURE);
    const parsed = parseWasmSections(bytes);
    assert.ok(parsed.codeSection, 'expected a code section');
    const spec = parsed.customSection('contractspecv0');
    assert.ok(spec, 'expected a contractspecv0 custom section');
    assert.ok(spec.length > 0);
  });
});

describe('stripDebugSections', () => {
  // Case 1 + 2 exercise the real debug fixture, which the pipeline uploads.
  describe('on the increment debug fixture', () => {
    let original: Uint8Array;
    let stripped: Uint8Array;

    before(async () => {
      original = Uint8Array.from(await fs.readFile(INCREMENT_DEBUG));
      stripped = stripDebugSections(original);
    });

    it('produces a module that re-parses cleanly with no .debug* custom section', () => {
      // Precondition: the fixture really does carry DWARF debug sections.
      const before = parseWasmSections(original);
      assert.ok(
        before.sections.some((s) => s.id === 0 && s.name?.startsWith('.debug')),
        'fixture precondition: expected .debug* custom sections in the input',
      );

      const after = parseWasmSections(stripped);
      const debugAfter = after.sections.filter(
        (s) => s.id === 0 && s.name?.startsWith('.debug'),
      );
      assert.deepStrictEqual(debugAfter, [], 'no .debug* section may survive');
    });

    it('is much smaller than the input (the DWARF is the bulk of the bytes)', () => {
      // ~2.4 MB of DWARF removed from a ~2.49 MB module: expect well under half.
      assert.ok(
        stripped.length < original.length / 2,
        `expected stripped (${stripped.length}) to be < half of input (${original.length})`,
      );
    });

    it('keeps the code section payload byte-identical (guarantees pos alignment)', () => {
      assert.deepStrictEqual(
        codePayload(stripped),
        codePayload(original),
        'code section content must be unchanged so trace pos still aligns with the DWARF',
      );
    });

    it('preserves every standard (non-custom) section, same ids in the same order', () => {
      const before = parseWasmSections(original);
      const after = parseWasmSections(stripped);
      const standardIds = (p: ReturnType<typeof parseWasmSections>): number[] =>
        p.sections.filter((s) => s.id !== 0).map((s) => s.id);
      assert.deepStrictEqual(standardIds(after), standardIds(before));
    });

    it('preserves every non-debug custom section, same names in the same order', () => {
      const before = parseWasmSections(original);
      const after = parseWasmSections(stripped);
      const nonDebugCustomNames = (p: ReturnType<typeof parseWasmSections>): (string | undefined)[] =>
        p.sections
          .filter((s) => s.id === 0 && !s.name?.startsWith('.debug'))
          .map((s) => s.name);

      const kept = nonDebugCustomNames(after);
      // Sanity: the meaningful Soroban customs are among them.
      assert.ok(kept.includes('contractspecv0'), 'contractspecv0 must survive');
      assert.ok(kept.includes('contractmetav0'), 'contractmetav0 must survive');
      assert.ok(kept.includes('contractenvmetav0'), 'contractenvmetav0 must survive');
      assert.deepStrictEqual(kept, nonDebugCustomNames(before));
    });

    it('preserves the byte content of a surviving custom section', () => {
      const before = parseWasmSections(original);
      const after = parseWasmSections(stripped);
      assert.deepStrictEqual(
        after.customSection('contractspecv0') &&
          Array.from(after.customSection('contractspecv0')!),
        Array.from(before.customSection('contractspecv0')!),
      );
    });
  });

  // Case 3: a module with no debug sections round-trips to an equivalent module.
  it('returns an equivalent module when there are no debug sections', async () => {
    const bytes = Uint8Array.from(await fs.readFile(NO_DEBUG));
    const before = parseWasmSections(bytes);
    // Precondition: this fixture truly has no .debug* sections.
    assert.ok(
      !before.sections.some((s) => s.id === 0 && s.name?.startsWith('.debug')),
      'fixture precondition: NO_DEBUG must lack .debug* sections',
    );

    const out = stripDebugSections(bytes);
    const after = parseWasmSections(out);
    // Same section ids and custom names, same order.
    assert.deepStrictEqual(
      after.sections.map((s) => [s.id, s.name]),
      before.sections.map((s) => [s.id, s.name]),
    );
    // Code section content unchanged.
    assert.deepStrictEqual(codePayload(out), codePayload(bytes));
    // In fact the whole module is byte-for-byte identical (nothing removed).
    assert.deepStrictEqual(Array.from(out), Array.from(bytes));
  });
});

describe('stripCustomSections', () => {
  // Hand-built module: a code section plus three custom sections. The predicate
  // removes exactly 'aaa' and 'ccc', leaving the code section and 'bbb' intact.
  //
  //   header
  //   code section:  id=10, payload [1,2,3]
  //   custom 'aaa':  content [0x10]        <- removed
  //   custom 'bbb':  content [0x20, 0x21]  <- kept
  //   custom 'ccc':  content [0x30]        <- removed
  const bytes = wasmModule(
    section(10, [1, 2, 3]),
    customSection('aaa', [0x10]),
    customSection('bbb', [0x20, 0x21]),
    customSection('ccc', [0x30]),
  );

  it('removes exactly the sections whose name matches the predicate', () => {
    const out = stripCustomSections(bytes, (n) => n === 'aaa' || n === 'ccc');
    const parsed = parseWasmSections(out);
    assert.deepStrictEqual(
      parsed.sections.map((s) => [s.id, s.name]),
      [
        [10, undefined],
        [0, 'bbb'],
      ],
    );
    // Kept custom content is intact.
    assert.deepStrictEqual(Array.from(parsed.customSection('bbb')!), [0x20, 0x21]);
    // Removed customs are gone.
    assert.strictEqual(parsed.customSection('aaa'), undefined);
    assert.strictEqual(parsed.customSection('ccc'), undefined);
  });

  it('keeps the code section payload byte-identical', () => {
    const out = stripCustomSections(bytes, (n) => n === 'aaa' || n === 'ccc');
    assert.deepStrictEqual(codePayload(out), codePayload(bytes));
  });

  it('never removes non-custom sections even if the predicate matches everything', () => {
    const out = stripCustomSections(bytes, () => true);
    const parsed = parseWasmSections(out);
    assert.deepStrictEqual(
      parsed.sections.map((s) => [s.id, s.name]),
      [[10, undefined]],
    );
    assert.deepStrictEqual(codePayload(out), codePayload(bytes));
  });

  it('returns an equivalent module when the predicate matches nothing', () => {
    const out = stripCustomSections(bytes, () => false);
    assert.deepStrictEqual(Array.from(out), Array.from(bytes));
  });

  // Case 5: malformed input is rejected via parseWasmSections.
  it('throws WasmFormatError on a malformed header', () => {
    const badMagic = Uint8Array.from([0x00, 0x61, 0x73, 0x00, 0x01, 0x00, 0x00, 0x00]);
    assert.throws(() => stripCustomSections(badMagic, () => true), WasmFormatError);
    assert.throws(() => stripDebugSections(badMagic), WasmFormatError);

    const tooShort = Uint8Array.from([0x00, 0x61, 0x73]);
    assert.throws(() => stripDebugSections(tooShort), WasmFormatError);
  });
});
