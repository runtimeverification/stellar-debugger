import * as assert from 'assert';
import * as fc from 'fast-check';
import { normalizeMnemonic, renderInstr } from '../../src/komet/mnemonics';

const TYPE_QUALIFIERS = ['i32', 'i64', 'f32', 'f64'];

// Bias the generator towards realistic instr arrays: a leading op string, an
// optional type qualifier, and arbitrary immediates.
const opArb = fc.oneof(
  fc.constantFrom('const', 'add', 'and', 'local.get', 'br_if', 'call', 'wrap_i64', 'unknown'),
  fc.string({ maxLength: 8 }),
);
const tailElem = fc.oneof(
  fc.constantFrom(...TYPE_QUALIFIERS),
  fc.integer({ min: -1000, max: 1000 }),
  fc.string({ maxLength: 6 }),
  fc.boolean(),
);
const instrArb = fc.tuple(opArb, fc.array(tailElem, { maxLength: 4 })).map(
  ([op, tail]) => [op, ...tail] as [string, ...unknown[]],
);

describe('property: mnemonics rendering is total', () => {
  it('normalizeMnemonic never throws and returns string|null', () => {
    fc.assert(
      fc.property(instrArb, (instr) => {
        const m = normalizeMnemonic(instr);
        assert.ok(m === null || typeof m === 'string');
      }),
    );
  });

  it('renderInstr never throws and always returns a string', () => {
    fc.assert(
      fc.property(instrArb, (instr) => {
        assert.strictEqual(typeof renderInstr(instr), 'string');
      }),
    );
  });

  it("the 'unknown' placeholder maps to null / 'unknown'", () => {
    fc.assert(
      fc.property(fc.array(tailElem, { maxLength: 4 }), (tail) => {
        const instr = ['unknown', ...tail] as [string, ...unknown[]];
        assert.strictEqual(normalizeMnemonic(instr), null);
        assert.strictEqual(renderInstr(instr), 'unknown');
      }),
    );
  });

  it('renderInstr starts with the normalized mnemonic for non-unknown ops', () => {
    fc.assert(
      fc.property(
        instrArb.filter((i) => i[0] !== 'unknown'),
        (instr) => {
          const mnemonic = normalizeMnemonic(instr);
          assert.ok(mnemonic !== null);
          const rendered = renderInstr(instr);
          // The rendered text always begins with the normalized mnemonic.
          assert.ok(rendered.startsWith(mnemonic), `${JSON.stringify(rendered)} should start with ${JSON.stringify(mnemonic)}`);
        },
      ),
    );
  });

  it('a leading value type is treated as a qualifier, not an immediate', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TYPE_QUALIFIERS),
        fc.constantFrom('const', 'add', 'store'),
        fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 3 }),
        (type, op, imms) => {
          const instr = [op, type, ...imms] as [string, ...unknown[]];
          assert.strictEqual(normalizeMnemonic(instr), `${type}.${op}`);
          // Immediates begin after the qualifier, so the rendered tail is imms.
          assert.strictEqual(renderInstr(instr), [`${type}.${op}`, ...imms.map(String)].join(' '));
        },
      ),
    );
  });
});
