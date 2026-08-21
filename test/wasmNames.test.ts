/**
 * The wasm symbol layer behind wasm-level call-stack frames (docs/callstack.md,
 * C4): the `name` custom section, the import count that maps body order to
 * function index, and Rust legacy demangling.
 *
 * Real fixtures pin the mapping (a name read for a body must be the name of
 * THAT body), and hand-built sections pin the leniency: a truncated name
 * section must degrade to the names read so far, never throw.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  demangleRust,
  functionNames,
  importedFunctionCount,
} from '../src/wasm/names';
import { Disassembly } from '../src/wasm/Disassembly';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const read = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));

/** A wasm module with just a header and one custom section. */
function moduleWithCustomSection(name: string, payload: number[]): Uint8Array {
  const nameBytes = Buffer.from(name, 'utf8');
  const content = [nameBytes.length, ...nameBytes, ...payload];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // header
    0x00, content.length, ...content, // custom section
  ]);
}

/**
 * A `name` section carrying only a function-name subsection. `claimed`
 * overstates the entry count, which is what a truncated section looks like.
 */
function nameSection(entries: [number, string][], claimed = entries.length): Uint8Array {
  const map: number[] = [claimed];
  for (const [index, name] of entries) {
    const bytes = Buffer.from(name, 'utf8');
    map.push(index, bytes.length, ...bytes);
  }
  return moduleWithCustomSection('name', [1, map.length, ...map]);
}

describe('wasm function names', () => {
  describe('functionNames', () => {
    it('reads the function-name map of a real contract', () => {
      const names = functionNames(read('stepper-debug.wasm'));
      assert.strictEqual(names.get(0), '_ZN7stepper6triple17h35eddc3334b434dbE');
      assert.strictEqual(names.get(1), 'sum_triples');
    });

    it('is empty for a module with no name section', () => {
      assert.strictEqual(functionNames(read('composite.wasm')).size, 0);
    });

    it('reads what it can from a truncated name section instead of throwing', () => {
      const entries: [number, string][] = [
        [0, 'first'],
        [1, 'second'],
      ];
      assert.deepStrictEqual([...functionNames(nameSection(entries))], entries);
      // A map claiming four entries but holding two: the two survive.
      assert.deepStrictEqual([...functionNames(nameSection(entries, 4))], entries);
    });

    it('degrades to empty on a malformed section rather than failing a session', () => {
      // A subsection claiming more bytes than the section holds…
      assert.strictEqual(functionNames(moduleWithCustomSection('name', [1, 99, 1])).size, 0);
      // …a name whose length runs past the payload…
      assert.strictEqual(functionNames(moduleWithCustomSection('name', [1, 4, 1, 0, 40, 0x66])).size, 0);
      // …and a subsection header cut off after its id.
      assert.strictEqual(functionNames(moduleWithCustomSection('name', [1])).size, 0);
    });

    it('skips subsections that are not the function-name map', () => {
      // Subsection 0 is the module name; the function map follows it.
      const moduleName = [0, 3, 2, 0x68, 0x69];
      const functions = [1, 5, 1, 7, 2, 0x66, 0x6e];
      const names = functionNames(moduleWithCustomSection('name', [...moduleName, ...functions]));
      assert.deepStrictEqual([...names], [[7, 'fn']]);
    });
  });

  describe('importedFunctionCount', () => {
    it('counts the imported host functions of a real contract', () => {
      // increment-debug.wasm imports three host functions; the arithmetic-only
      // fixtures import none at all (they carry no import section).
      assert.strictEqual(importedFunctionCount(read('increment-debug.wasm')), 3);
      assert.strictEqual(importedFunctionCount(read('stepper-debug.wasm')), 0);
    });

    it('offsets body order into function-index space', () => {
      // The i-th function body is function index importCount + i, so the name a
      // range reports must be the name of that body's own function. stepper's
      // three bodies are `triple`, the `#[contractimpl]` wrapper, and the SDK's
      // section shim, in that order.
      const bytes = read('stepper-debug.wasm');
      const ranges = Disassembly.fromWasm(bytes).functionRanges;
      assert.strictEqual(ranges[0].index, importedFunctionCount(bytes));
      assert.strictEqual(ranges[0].name, 'stepper::triple');
      assert.strictEqual(ranges[1].name, 'sum_triples');
      assert.strictEqual(ranges[1].index, 1);
    });

    it('leaves a range unnamed when the module carries no name section', () => {
      for (const range of Disassembly.fromWasm(read('composite.wasm')).functionRanges) {
        assert.strictEqual(range.name, undefined);
        assert.strictEqual(typeof range.index, 'number');
      }
    });

    it('names nothing at all for a trace-derived disassembly', () => {
      // Disassembly.fromTrace knows no function structure, so there are no
      // ranges to name — the wasm-level frame ladder ends at the address.
      const model = { records: [{ pos: 4, instr: ['nop'] }] } as never;
      assert.deepStrictEqual(Disassembly.fromTrace(model).functionRanges, []);
    });
  });

  describe('demangleRust', () => {
    it('demangles a legacy symbol and drops its hash segment', () => {
      assert.strictEqual(demangleRust('_ZN7control7Control10while_call17h0b04c88804cf85f6E'), 'control::Control::while_call');
      assert.strictEqual(demangleRust('_ZN7control4bump17h2628dce790f861d2E'), 'control::bump');
    });

    it('decodes the $…$ escapes and `..` path separators', () => {
      assert.strictEqual(
        demangleRust('_ZN60_$LT$soroban_sdk..env..Env$u20$as$u20$core..clone..Clone$GT$5clone17h1357aacfed26b0c7E'),
        '<soroban_sdk::env::Env as core::clone::Clone>::clone',
      );
      assert.strictEqual(demangleRust('_ZN1a5b$C$c17h0000000000000000E'), 'a::b,c');
    });

    it('passes through anything that is not legacy-mangled', () => {
      // In order: a plain symbol, a v0-mangled one (documented as not demangled),
      // the empty string, a body that is not length-prefixed, a length running
      // past the end, and a `_ZN…E` with no segments at all.
      for (const symbol of [
        'sum_triples',
        '_RNvC7control4bump',
        '',
        '_ZNnot_a_lengthE',
        '_ZN99tooshortE',
        '_ZNE',
      ]) {
        assert.strictEqual(demangleRust(symbol), symbol);
      }
    });
  });
});
