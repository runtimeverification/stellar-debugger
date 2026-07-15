import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { DwarfDebugInfo } from '../src/dwarf/DebugInfo';
import {
  VariableResolver,
  NullVariableResolver,
  DwarfVariableResolver,
} from '../src/sourcemap/VariableResolver';
import { ScopeVar } from '../src/dwarf/ScopeIndex';
import { parseTraceJsonl, TraceRecord } from '../src/komet/trace';
import { MemoryImage } from '../src/debugAdapter/MemoryImage';
import { makeRuntimeState } from '../src/debugAdapter/runtimeState';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');

// DWARF opcode bytes exercised by the adder parameters' inline location lists.
const DW_OP_WASM_location = 0xed;
const WASM_LOCATION_KIND_LOCAL = 0x00;

/** A minimal, syntactically valid trace record for constructing a RuntimeState. */
function syntheticRecord(): TraceRecord {
  const [record] = parseTraceJsonl('{"pos":0,"instr":["nop"],"stack":[],"locals":{}}');
  return record;
}

describe('sourcemap/VariableResolver', () => {
  describe('NullVariableResolver', () => {
    // Typed through the interface: decodeVariable's arity comes from the contract.
    const resolver: VariableResolver = new NullVariableResolver();

    it('reports no variables', () => {
      assert.strictEqual(resolver.hasVariables(), false);
    });

    it('variablesInScope is always empty', () => {
      assert.deepStrictEqual(resolver.variablesInScope(0), []);
      assert.deepStrictEqual(resolver.variablesInScope(12345), []);
    });

    it('functionNameAt is always null', () => {
      assert.strictEqual(resolver.functionNameAt(0), null);
      assert.strictEqual(resolver.functionNameAt(12345), null);
    });

    it('decodeVariable yields the <unavailable> placeholder', () => {
      const state = makeRuntimeState(syntheticRecord(), new MemoryImage([]), 0);
      const anyVar: ScopeVar = { optimizedOut: false, isParam: true };
      assert.deepStrictEqual(resolver.decodeVariable(anyVar, state, 0), { display: '<unavailable>' });
    });
  });

  describe('DwarfVariableResolver end-to-end on the adder fixture', () => {
    let resolver: DwarfVariableResolver;
    let records: TraceRecord[];
    let addIndex: number;
    let addPc: number;
    let addRecord: TraceRecord;
    let state: ReturnType<typeof makeRuntimeState>;

    before(async () => {
      const wasm = await fs.readFile(ADDER_WASM);
      const dwarf = DwarfDebugInfo.fromWasm(wasm);
      assert.ok(dwarf, 'expected DWARF debug info from the adder build');
      resolver = new DwarfVariableResolver(dwarf);

      const text = await fs.readFile(ADDER_TRACE, 'utf8');
      records = parseTraceJsonl(text);
      addIndex = records.findIndex(
        (r) => r.pos !== null && r.instr[0] === 'add' && r.instr[1] === 'i32',
      );
      assert.ok(addIndex >= 0, 'trace fixture must contain an ["add","i32"] record with a pos');
      addRecord = records[addIndex];
      assert.ok(addRecord.pos !== null);
      addPc = addRecord.pos as number;

      // A MemoryImage folded over the whole trace; RuntimeState at the add cursor.
      const memory = new MemoryImage(records);
      state = makeRuntimeState(addRecord, memory, addIndex);
    });

    it('hasVariables() is true for a build with subprograms', () => {
      assert.strictEqual(resolver.hasVariables(), true);
    });

    it('functionNameAt(pc) is a non-empty name', () => {
      const name = resolver.functionNameAt(addPc);
      assert.strictEqual(typeof name, 'string');
      assert.ok((name as string).length > 0, `expected a function name at pc ${addPc}`);
    });

    it('variablesInScope(pc) returns the two parameters arg_0 and arg_1', () => {
      const vars = resolver.variablesInScope(addPc);
      assert.strictEqual(vars.length, 2, 'expected exactly two in-scope variables');
      assert.ok(vars.every((v) => v.isParam), 'both must be formal parameters');
      const names = vars.map((v) => v.name).sort();
      assert.deepStrictEqual(names, ['arg_0', 'arg_1']);
    });

    it('each parameter is bound to a WASM local slot present in the trace record', () => {
      // The pipeline surfaces each parameter with an inline DW_AT_location of the
      // form `DW_OP_WASM_location <local> N ; DW_OP_stack_value` — i.e. the value
      // lives in wasm local N. This is the ScopeIndex -> location linkage the
      // resolver depends on; verify N is an actual local carried by this record.
      const vars = resolver.variablesInScope(addPc);
      for (const v of vars) {
        assert.ok(v.locationExpr instanceof Uint8Array, `${v.name} must carry an inline location expr`);
        const expr = v.locationExpr as Uint8Array;
        assert.strictEqual(expr[0], DW_OP_WASM_location, `${v.name} location must be a WASM_location`);
        assert.strictEqual(expr[1], WASM_LOCATION_KIND_LOCAL, `${v.name} must target a wasm local`);
        const localIndex = expr[2]; // small single-byte ULEB index in this fixture.
        assert.ok(
          Object.prototype.hasOwnProperty.call(addRecord.locals, String(localIndex)),
          `${v.name} targets local ${localIndex}, which must appear in record.locals`,
        );
      }
    });

    it('decodeVariable(param, state, pc) decodes each parameter to the decimal of its wasm local', () => {
      // Exercises ScopeIndex -> locexpr -> ValueDecoder -> RuntimeState end to end.
      // Each parameter's location is `DW_OP_WASM_location <local> N ; DW_OP_stack_value`,
      // so the resolved value IS the content of wasm local N. Both params are the
      // Soroban `Val` newtype (an 8-byte scalar), so the decoded display must equal
      // the decimal string of local N as carried by this trace record — the headline
      // M8 capability: inspecting a variable's real runtime value.
      const vars = resolver.variablesInScope(addPc);
      assert.strictEqual(vars.length, 2, 'expected exactly the two parameters');
      for (const v of vars) {
        const expr = v.locationExpr as Uint8Array;
        const localIndex = expr[2]; // single-byte ULEB local index in this fixture.
        const typed = addRecord.locals[String(localIndex)];
        assert.ok(typed, `${v.name} must target a local present in the record`);
        const expected = String(typed[1]);

        const decoded = resolver.decodeVariable(v, state, addPc);
        assert.ok(decoded && typeof decoded.display === 'string', `${v.name} must decode to a DecodedValue`);
        assert.strictEqual(
          decoded.display,
          expected,
          `${v.name} must decode to the decimal of wasm local ${localIndex} (${expected}), not a placeholder`,
        );
      }
    });

    it('parameters carry cuLowPc from their owning compilation unit', () => {
      // The adder's covering subprogram belongs to the first CU (DW_AT_low_pc = 2),
      // so variablesInScope must stamp cuLowPc = 2 onto each variable (needed for
      // .debug_loc base addressing).
      const vars = resolver.variablesInScope(addPc);
      for (const v of vars) {
        assert.strictEqual(typeof v.cuLowPc, 'number', `${v.name} must carry a numeric cuLowPc`);
        assert.strictEqual(v.cuLowPc, 2, `${v.name} cuLowPc must come from the owning CU`);
      }
    });
  });

  describe('DwarfVariableResolver.decodeVariable degradation', () => {
    let resolver: DwarfVariableResolver;

    before(async () => {
      const wasm = await fs.readFile(ADDER_WASM);
      const dwarf = DwarfDebugInfo.fromWasm(wasm);
      assert.ok(dwarf);
      resolver = new DwarfVariableResolver(dwarf);
    });

    it('an optimized-out variable (no location) yields <optimized out>', () => {
      const state = makeRuntimeState(syntheticRecord(), new MemoryImage([]), 0);
      // A variable with neither an inline exprloc nor a loclist offset.
      const optimizedOut: ScopeVar = { name: 'x', optimizedOut: true, isParam: false };
      const decoded = resolver.decodeVariable(optimizedOut, state, 0);
      assert.strictEqual(decoded.display, '<optimized out>');
    });
  });
});
