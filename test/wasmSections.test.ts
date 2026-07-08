import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { parseWasmSections, WasmFormatError } from '../src/wasm/sections';
import { WASM_HEADER, customSection, section, wasmModule } from './support/wasmBytes';

const FIXTURE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'sample_contract.wasm');

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
