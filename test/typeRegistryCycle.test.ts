import * as assert from 'assert';
import { TypeRegistry, TypedefType } from '../src/dwarf/TypeRegistry';
import { Die } from '../src/dwarf/die';
import { DW_TAG_typedef, DW_TAG_const_type, DW_AT_type } from '../src/dwarf/constants';

/** A minimal DIE that references another DIE offset via DW_AT_type. */
function refDie(secOffset: number, tag: number, targetOffset: number): Die {
  return {
    secOffset,
    tag,
    attrs: new Map([[DW_AT_type, { kind: 'ref', value: targetOffset }]]),
    children: [],
  };
}

describe('TypeRegistry.stripTypedefs cycle handling', () => {
  it('terminates on a cyclic typedef chain instead of looping forever', function () {
    // Malformed DWARF: typedef @10 -> typedef @20 -> back to @10.
    this.timeout(3000);
    const dies = new Map<number, Die>([
      [10, refDie(10, DW_TAG_typedef, 20)],
      [20, refDie(20, DW_TAG_typedef, 10)],
    ]);
    const registry = new TypeRegistry(dies);

    const start = registry.resolve(10) as TypedefType;
    assert.strictEqual(start.kind, 'typedef');

    // Must return (not hang). The exact stopping point is an implementation
    // detail; what matters is that it terminates and yields a real type.
    const result = registry.stripTypedefs(start);
    assert.ok(result, 'stripTypedefs must return a type');
    assert.ok(['typedef', 'qualifier', 'unresolved', 'base', 'struct', 'pointer'].includes(result.kind));
  });

  it('terminates on a self-referential qualifier', function () {
    this.timeout(3000);
    const dies = new Map<number, Die>([[30, refDie(30, DW_TAG_const_type, 30)]]);
    const registry = new TypeRegistry(dies);
    const start = registry.resolve(30);
    const result = registry.stripTypedefs(start);
    assert.ok(result);
  });

  it('still fully strips a normal typedef -> qualifier -> base chain', function () {
    // typedef @1 -> const @2 -> base @3
    const dies = new Map<number, Die>([
      [1, refDie(1, DW_TAG_typedef, 2)],
      [2, refDie(2, DW_TAG_const_type, 3)],
      [3, { secOffset: 3, tag: 0x24 /* DW_TAG_base_type */, attrs: new Map(), children: [] }],
    ]);
    const registry = new TypeRegistry(dies);
    const result = registry.stripTypedefs(registry.resolve(1));
    assert.strictEqual(result.kind, 'base');
  });
});
