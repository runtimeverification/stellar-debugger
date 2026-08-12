import * as assert from 'assert';
import { StrKey } from '@stellar/stellar-sdk';
import { ScValJson } from '../src/komet/trace';
import { renderScVal, renderAddress, summarizeScVal, scvalKey } from '../src/soroban/scvalJson';
import { DecodedValue } from '../src/dwarf/ValueDecoder';

/** The children of a rendered value, or [] when it is not expandable. */
function children(value: DecodedValue): { name: string; display: string; typeName?: string }[] {
  if (!value.children) {
    return [];
  }
  return value.children().map((c) => ({
    name: c.name,
    display: c.value.display,
    typeName: c.value.typeName,
  }));
}

const CONTRACT_HEX = '07'.repeat(32);
const ACCOUNT_HEX = '08'.repeat(32);

describe('ScVal-JSON rendering (docs/state-inspection.md, Presentation)', () => {
  // ------------------------------------------------------------------ scalars

  it('renders scalars with the value in display and the type in typeName', () => {
    const cases: [ScValJson, string, string][] = [
      [{ type: 'void' }, 'void', 'void'],
      [{ type: 'bool', value: true }, 'true', 'bool'],
      [{ type: 'u32', value: 5 }, '5', 'u32'],
      [{ type: 'i32', value: -5 }, '-5', 'i32'],
      [{ type: 'u64', value: 42 }, '42', 'u64'],
      [{ type: 'symbol', value: 'COUNTER' }, 'COUNTER', 'symbol'],
      [{ type: 'string', value: 'hi' }, '"hi"', 'string'],
      [{ type: 'bytes', value: 'ab12' }, '0xab12', 'bytes'],
    ];
    for (const [input, display, typeName] of cases) {
      const rendered = renderScVal(input);
      assert.strictEqual(rendered.display, display, `display of ${JSON.stringify(input)}`);
      assert.strictEqual(rendered.typeName, typeName, `typeName of ${JSON.stringify(input)}`);
      assert.strictEqual(rendered.children, undefined, 'scalars are not expandable');
    }
  });

  // komet emits u128/i128/u256 as JSON numbers, so a large value has already
  // lost precision by the time it reaches the adapter. A decimal STRING is
  // accepted so the display stays exact once a producer emits one.
  it('renders a big integer given as a decimal string exactly', () => {
    const big = '340282366920938463463374607431768211455';
    const rendered = renderScVal({ type: 'u128', value: big });
    assert.strictEqual(rendered.display, big);
    assert.strictEqual(rendered.typeName, 'u128');
  });

  it('renders an error with its type and code', () => {
    const rendered = renderScVal({ type: 'error', errType: 'contract', code: 3 });
    assert.strictEqual(rendered.typeName, 'error');
    assert.ok(rendered.display.includes('contract'), rendered.display);
    assert.ok(rendered.display.includes('3'), rendered.display);
  });

  it('renders an unmodelled ScVal type generically instead of throwing', () => {
    const rendered = renderScVal({ type: 'someFutureType', value: 7 } as ScValJson);
    assert.strictEqual(rendered.typeName, 'someFutureType');
    assert.strictEqual(rendered.display, '7');
  });

  // ------------------------------------------------------------------ addresses

  it('renders a 32-byte contract address as a C… strkey', () => {
    const strkey = renderAddress({ addrType: 'contract', value: CONTRACT_HEX });
    assert.strictEqual(strkey, StrKey.encodeContract(Buffer.from(CONTRACT_HEX, 'hex')));
    assert.ok(strkey.startsWith('C'), strkey);
  });

  it('renders a 32-byte account address as a G… strkey', () => {
    const strkey = renderAddress({ addrType: 'account', value: ACCOUNT_HEX });
    assert.strictEqual(strkey, StrKey.encodeEd25519PublicKey(Buffer.from(ACCOUNT_HEX, 'hex')));
    assert.ok(strkey.startsWith('G'), strkey);
  });

  // komet's own tests use short ids like "63", which are not valid strkeys.
  // Those must render as hex rather than throwing or producing a bogus strkey.
  it('falls back to hex for an address that is not 32 bytes', () => {
    assert.strictEqual(renderAddress({ addrType: 'contract', value: '63' }), '0x63');
    assert.strictEqual(renderAddress({ addrType: 'account', value: '' }), '0x');
  });

  it('renders an address ScVal through the strkey path', () => {
    const rendered = renderScVal({ type: 'address', addrType: 'contract', value: CONTRACT_HEX });
    assert.strictEqual(rendered.display, StrKey.encodeContract(Buffer.from(CONTRACT_HEX, 'hex')));
    assert.strictEqual(rendered.typeName, 'address');
  });

  // ------------------------------------------------------------------ composites

  it('renders a vec with a count and indexed children', () => {
    const rendered = renderScVal({
      type: 'vec',
      value: [
        { type: 'u32', value: 1 },
        { type: 'symbol', value: 'a' },
      ],
    });
    assert.strictEqual(rendered.display, 'vec[2]');
    assert.deepStrictEqual(children(rendered), [
      { name: '[0]', display: '1', typeName: 'u32' },
      { name: '[1]', display: 'a', typeName: 'symbol' },
    ]);
  });

  it('renders a map with a count and key-named children', () => {
    const rendered = renderScVal({
      type: 'map',
      value: [
        [
          { type: 'symbol', value: 'k' },
          { type: 'u32', value: 9 },
        ],
      ],
    });
    assert.strictEqual(rendered.display, 'map{1}');
    assert.deepStrictEqual(children(rendered), [{ name: 'k', display: '9', typeName: 'u32' }]);
  });

  it('renders nested composites lazily and to depth', () => {
    const rendered = renderScVal({
      type: 'vec',
      value: [{ type: 'vec', value: [{ type: 'u32', value: 1 }] }],
    });
    const [inner] = rendered.children!();
    assert.strictEqual(inner.value.display, 'vec[1]');
    assert.deepStrictEqual(children(inner.value), [{ name: '[0]', display: '1', typeName: 'u32' }]);
  });

  it('renders an empty vec and an empty map without children', () => {
    assert.strictEqual(renderScVal({ type: 'vec', value: [] }).display, 'vec[0]');
    assert.strictEqual(renderScVal({ type: 'map', value: [] }).display, 'map{0}');
  });

  // ------------------------------------------------------------------ summaries

  it('summarizes a value as type(display) for one-line labels', () => {
    assert.strictEqual(summarizeScVal({ type: 'symbol', value: 'COUNTER' }), 'symbol(COUNTER)');
    assert.strictEqual(summarizeScVal({ type: 'u32', value: 5 }), 'u32(5)');
    assert.strictEqual(summarizeScVal({ type: 'void' }), 'void');
  });

  // ------------------------------------------------------------------ identity keys

  it('gives equal keys to structurally equal values', () => {
    assert.strictEqual(
      scvalKey({ type: 'symbol', value: 'k' }),
      scvalKey({ type: 'symbol', value: 'k' }),
    );
    // Key order in the JSON object must not change identity.
    assert.strictEqual(
      scvalKey({ type: 'address', addrType: 'contract', value: '63' }),
      scvalKey({ value: '63', addrType: 'contract', type: 'address' } as ScValJson),
    );
  });

  it('gives different keys to values that differ in type or value', () => {
    const keys = new Set([
      scvalKey({ type: 'symbol', value: 'k' }),
      scvalKey({ type: 'string', value: 'k' }),
      scvalKey({ type: 'symbol', value: 'j' }),
      scvalKey({ type: 'u32', value: 1 }),
      scvalKey({ type: 'i32', value: 1 }),
      scvalKey({ type: 'void' }),
    ]);
    assert.strictEqual(keys.size, 6);
  });

  it('gives composite keys that respect element order', () => {
    const ab = scvalKey({
      type: 'vec',
      value: [
        { type: 'u32', value: 1 },
        { type: 'u32', value: 2 },
      ],
    });
    const ba = scvalKey({
      type: 'vec',
      value: [
        { type: 'u32', value: 2 },
        { type: 'u32', value: 1 },
      ],
    });
    assert.notStrictEqual(ab, ba);
  });

  // Within one type a JSON number and its decimal string denote the SAME
  // integer, so they must share a key — otherwise a producer that switches
  // big-int encoding (komet emits numbers today) would split one storage entry
  // into two. A different `type` still separates them.
  it('treats a number and its decimal string as the same value', () => {
    assert.strictEqual(scvalKey({ type: 'u128', value: 5 }), scvalKey({ type: 'u128', value: '5' }));
    assert.notStrictEqual(
      scvalKey({ type: 'u128', value: 5 }),
      scvalKey({ type: 'string', value: '5' }),
    );
  });
});
