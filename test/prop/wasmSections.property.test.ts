import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  parseWasmSections,
  stripCustomSections,
  WasmFormatError,
} from '../../src/wasm/sections';
import { WASM_HEADER, section, customSection, wasmModule } from '../support/wasmBytes';

const HEADER_LEN = WASM_HEADER.length; // 8

// A section descriptor the generator can encode two ways: as a plain section
// (id 1..11, never 0) or as a named custom section (id 0).
type Desc =
  | { kind: 'plain'; id: number; payload: number[] }
  | { kind: 'custom'; name: string; content: number[] };

const byteArb = fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 24 });

const descArb: fc.Arbitrary<Desc> = fc.oneof(
  fc.record({
    kind: fc.constant<'plain'>('plain'),
    id: fc.integer({ min: 1, max: 11 }),
    payload: byteArb,
  }),
  fc.record({
    kind: fc.constant<'custom'>('custom'),
    name: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !s.includes(String.fromCharCode(0))),
    content: byteArb,
  }),
);

function encode(desc: Desc): number[] {
  return desc.kind === 'plain' ? section(desc.id, desc.payload) : customSection(desc.name, desc.content);
}

describe('property: parseWasmSections structural invariants', () => {
  it('sections tile the module contiguously with no gaps or overlaps', () => {
    fc.assert(
      fc.property(fc.array(descArb, { maxLength: 12 }), (descs) => {
        const bytes = wasmModule(...descs.map(encode));
        const { sections } = parseWasmSections(bytes);
        let cursor = HEADER_LEN;
        for (const s of sections) {
          assert.strictEqual(s.start, cursor, 'section must start where the previous one ended');
          assert.ok(s.payloadStart >= s.start + 1, 'payload starts after at least the id byte');
          assert.ok(s.payloadStart <= s.payloadEnd, 'payload start <= payload end');
          cursor = s.payloadEnd;
        }
        assert.strictEqual(cursor, bytes.length, 'sections must cover the whole buffer');
        assert.strictEqual(sections.length, descs.length);
      }),
    );
  });

  it('round-trips plain payloads and custom-section contents', () => {
    fc.assert(
      fc.property(
        // Unique custom-section names so first-wins lookup is unambiguous.
        fc.uniqueArray(descArb, {
          maxLength: 10,
          selector: (d) => (d.kind === 'custom' ? `c:${d.name}` : Symbol()),
        }),
        (descs) => {
          const bytes = wasmModule(...descs.map(encode));
          const parsed = parseWasmSections(bytes);
          descs.forEach((d, i) => {
            const s = parsed.sections[i];
            if (d.kind === 'plain') {
              assert.strictEqual(s.id, d.id);
              assert.deepStrictEqual([...bytes.subarray(s.payloadStart, s.payloadEnd)], d.payload);
            } else {
              assert.strictEqual(s.id, 0);
              assert.strictEqual(s.name, d.name);
              assert.deepStrictEqual([...(parsed.customSection(d.name) ?? [])], d.content);
            }
          });
        },
      ),
    );
  });
});

describe('property: stripCustomSections', () => {
  it('is idempotent and byte-preserving for the sections it keeps', () => {
    fc.assert(
      fc.property(fc.array(descArb, { maxLength: 12 }), fc.string({ maxLength: 4 }), (descs, prefix) => {
        const bytes = wasmModule(...descs.map(encode));
        const pred = (name: string): boolean => name.startsWith(prefix);
        const once = stripCustomSections(bytes, pred);
        const twice = stripCustomSections(once, pred);
        // Idempotent: stripping again changes nothing.
        assert.deepStrictEqual([...twice], [...once]);
        // Every surviving section re-parses cleanly, and no kept custom section
        // matches the predicate.
        const survivors = parseWasmSections(once);
        for (const s of survivors.sections) {
          if (s.id === 0 && s.name !== undefined) {
            assert.ok(!pred(s.name), `kept a section that should have been stripped: ${s.name}`);
          }
        }
      }),
    );
  });

  it('a never-match predicate yields a module that re-parses to the same sections', () => {
    fc.assert(
      fc.property(fc.array(descArb, { maxLength: 12 }), (descs) => {
        const bytes = wasmModule(...descs.map(encode));
        const copy = stripCustomSections(bytes, () => false);
        const a = parseWasmSections(bytes).sections;
        const b = parseWasmSections(copy).sections;
        assert.deepStrictEqual(
          b.map((s) => [s.id, s.name]),
          a.map((s) => [s.id, s.name]),
        );
      }),
    );
  });
});

describe('property: parseWasmSections never crashes on arbitrary bytes', () => {
  it('returns a ParsedWasm or throws WasmFormatError, nothing else', () => {
    const arb = fc.oneof(
      fc.uint8Array({ maxLength: 128 }),
      // Bias towards well-formed headers so the section loop is exercised.
      fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 120 }).map((tail) => Uint8Array.from([...WASM_HEADER, ...tail])),
    );
    fc.assert(
      fc.property(arb, (bytes) => {
        try {
          const parsed = parseWasmSections(bytes);
          assert.ok(Array.isArray(parsed.sections));
        } catch (e) {
          assert.ok(e instanceof WasmFormatError, `unexpected error: ${(e as Error).constructor.name}: ${(e as Error).message}`);
        }
      }),
    );
  });
});
