import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { DwarfDebugInfo } from '../src/dwarf/DebugInfo';
import { ScopeIndex } from '../src/dwarf/ScopeIndex';
import { DwarfParseError } from '../src/dwarf/cursor';
import { parseWasmSections } from '../src/wasm/sections';

// Fixtures live under test/fixtures; __dirname is out/test after compilation,
// so ../../test/fixtures resolves back to the source tree (see dwarf.test.ts).
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');
const STRIPPED_WASM = path.join(FIXTURES, 'sample_contract.wasm');

// The traced `i32.add` in the adder fixture sits at code offset 45; its
// enclosing (inlined-into) subprogram carries the parameters we inspect below.
const ADD_PC = 45;

describe('dwarf/DebugInfo', () => {
  describe('DwarfDebugInfo.fromWasm on the adder debug fixture', () => {
    let dwarf: DwarfDebugInfo;

    before(async () => {
      const bytes = await fs.readFile(ADDER_WASM);
      const result = DwarfDebugInfo.fromWasm(bytes);
      assert.ok(result, 'expected a DwarfDebugInfo from the debug build');
      dwarf = result;
    });

    it('returns an instance wiring together info, types, scopes, and debugLoc', () => {
      // .debug_info parsed into at least one compilation unit.
      assert.ok(Array.isArray(dwarf.info.units), 'info.units must be an array');
      assert.ok(dwarf.info.units.length >= 1, 'expected at least one compilation unit');
      // scopes is a real ScopeIndex built over that debug info.
      assert.ok(dwarf.scopes instanceof ScopeIndex, 'scopes must be a ScopeIndex');
    });

    it('scopes.hasFunctions() is true (the fixture indexes subprograms)', () => {
      assert.strictEqual(dwarf.scopes.hasFunctions(), true);
    });

    it('scopes are usable: functionNameAt / variablesInScope resolve at the add pc', () => {
      const name = dwarf.scopes.functionNameAt(ADD_PC);
      assert.strictEqual(typeof name, 'string');
      assert.ok((name as string).length > 0, 'expected a non-empty enclosing function name');
      const vars = dwarf.scopes.variablesInScope(ADD_PC);
      assert.ok(vars.length > 0, 'expected variables in scope at the add pc');
    });

    it('types are usable: resolving a variable typeRef yields a structured type', () => {
      const vars = dwarf.scopes.variablesInScope(ADD_PC);
      const withType = vars.find((v) => v.typeRef !== undefined);
      assert.ok(withType, 'expected at least one variable carrying a typeRef');
      const type = dwarf.types.resolve(withType.typeRef);
      assert.ok(type && typeof type.kind === 'string', 'resolve must return a tagged DwarfType');
    });

    it('debugLoc is the .debug_loc section bytes (adder carries a location list)', () => {
      assert.ok(dwarf.debugLoc instanceof Uint8Array, 'debugLoc must be a Uint8Array');
      assert.ok((dwarf.debugLoc as Uint8Array).length > 0, 'expected non-empty .debug_loc');
    });
  });

  it('fromWasm returns null for a stripped module (no .debug_info/.debug_abbrev)', async () => {
    const bytes = await fs.readFile(STRIPPED_WASM);
    assert.strictEqual(DwarfDebugInfo.fromWasm(bytes), null);
  });

  it('fromWasm propagates DwarfParseError for an unsupported .debug_info version', async () => {
    const doctored = Uint8Array.from(await fs.readFile(ADDER_WASM));
    const debugInfo = parseWasmSections(doctored).sections.find((s) => s.name === '.debug_info');
    assert.ok(debugInfo, 'fixture must have a .debug_info section');
    // The version u16 sits right after the 4-byte unit_length of the first unit.
    // Overwrite it with 3 (unsupported; parseDebugInfo accepts only 4 and 5).
    doctored[debugInfo.payloadStart + 4] = 3;
    doctored[debugInfo.payloadStart + 5] = 0;
    assert.throws(() => DwarfDebugInfo.fromWasm(doctored), DwarfParseError);
  });
});
