import * as assert from 'assert';
import { normalizeMnemonic, renderInstr } from '../src/komet/mnemonics';

describe('komet/mnemonics', () => {
  describe('normalizeMnemonic', () => {
    it('prefixes the type qualifier for typed ops', () => {
      assert.strictEqual(normalizeMnemonic(['const', 'i64', 255]), 'i64.const');
      assert.strictEqual(normalizeMnemonic(['and', 'i64']), 'i64.and');
    });

    it('handles conversion ops whose result type is the qualifier', () => {
      assert.strictEqual(normalizeMnemonic(['wrap_i64', 'i32']), 'i32.wrap_i64');
      assert.strictEqual(normalizeMnemonic(['extend_i32_u', 'i64']), 'i64.extend_i32_u');
    });

    it('does not treat a numeric immediate as a type qualifier', () => {
      assert.strictEqual(normalizeMnemonic(['br_if', 0]), 'br_if');
      assert.strictEqual(normalizeMnemonic(['local.get', 1]), 'local.get');
      assert.strictEqual(normalizeMnemonic(['call', 7]), 'call');
    });

    it('passes through untyped ops with no operands', () => {
      assert.strictEqual(normalizeMnemonic(['block']), 'block');
      assert.strictEqual(normalizeMnemonic(['return']), 'return');
    });

    it("returns null for komet's 'unknown' placeholder", () => {
      assert.strictEqual(normalizeMnemonic(['unknown']), null);
    });
  });

  describe('renderInstr', () => {
    it('renders the normalized mnemonic followed by the immediates', () => {
      assert.strictEqual(renderInstr(['const', 'i64', 255]), 'i64.const 255');
      assert.strictEqual(renderInstr(['br_if', 0]), 'br_if 0');
      assert.strictEqual(renderInstr(['local.get', 1]), 'local.get 1');
      assert.strictEqual(renderInstr(['call', 7]), 'call 7');
    });

    it('renders typed ops without immediates as the bare mnemonic', () => {
      assert.strictEqual(renderInstr(['and', 'i64']), 'i64.and');
      assert.strictEqual(renderInstr(['wrap_i64', 'i32']), 'i32.wrap_i64');
      assert.strictEqual(renderInstr(['extend_i32_u', 'i64']), 'i64.extend_i32_u');
    });

    it('renders untyped no-operand ops as the bare op', () => {
      assert.strictEqual(renderInstr(['block']), 'block');
    });

    it("renders komet's 'unknown' placeholder as 'unknown'", () => {
      assert.strictEqual(renderInstr(['unknown']), 'unknown');
    });
  });
});
