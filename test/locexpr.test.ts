import * as assert from 'assert';
import {
  evalLocation,
  registerValue,
  RuntimeState,
  ValueLocation,
} from '../src/dwarf/locexpr';
import * as C from '../src/dwarf/constants';

// A DWARF location expression is a byte program for a little stack machine. Every
// input below is hand-built with a byte-by-byte comment so the encoding is legible.
//
// Relevant opcodes (see src/dwarf/constants.ts):
//   DW_OP_addr          0x03  <addressSize bytes>            push
//   DW_OP_plus_uconst   0x23  <uleb>                         pop, add, push
//   DW_OP_fbreg         0x91  <sleb>                         push frameBaseValue+offset
//   DW_OP_piece         0x93  <uleb>                         (degrades -> unavailable)
//   DW_OP_stack_value   0x9f                                 value-mode flag
//   DW_OP_WASM_location 0xed  <u8 kind> <index>              set pending register
//     kind 0 local  (uleb index)
//     kind 1 global (uleb index)
//     kind 2 stack  (uleb index)
//     kind 3 global (FIXED u32 index, NOT uleb)

/** Build a location-expression byte buffer. */
function expr(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

/** Asserts the location's discriminant and returns it narrowed to that variant. */
function expect<K extends ValueLocation['kind']>(
  v: ValueLocation,
  kind: K,
): Extract<ValueLocation, { kind: K }> {
  assert.strictEqual(v.kind, kind, `expected kind '${kind}', got '${v.kind}'`);
  return v as Extract<ValueLocation, { kind: K }>;
}

/** A hand-configured mock of the replay-cursor runtime state. */
function mockState(
  opts: {
    locals?: Record<number, number | bigint>;
    globals?: Record<number, number | bigint>;
    stacks?: Record<number, number | bigint>;
    mem?: Record<number, Uint8Array>;
  } = {},
): RuntimeState {
  return {
    localValue: (i) => opts.locals?.[i],
    globalValue: (i) => opts.globals?.[i],
    stackValue: (i) => opts.stacks?.[i],
    readMemory: (addr) => opts.mem?.[addr],
  };
}

describe('dwarf/locexpr — evalLocation', () => {
  describe('lone DW_OP_WASM_location register (kinds 0/1/2, ULEB index)', () => {
    // Index 300 = ULEB128 [0xac, 0x02] — a multi-byte value that proves ULEB
    // decoding (a naive u8 read would yield 0xac = 172, not 300).
    const INDEX = 300;
    const ULEB_300 = [0xac, 0x02];

    it('kind 0 -> {local, index}', () => {
      // 0xed WASM_location, 0x00 kind=local, 0xac 0x02 uleb index 300
      const loc = evalLocation(
        expr(C.DW_OP_WASM_location, 0x00, ...ULEB_300),
        undefined,
        mockState(),
      );
      const r = expect(loc, 'local');
      assert.strictEqual(r.index, INDEX);
    });

    it('kind 1 -> {global, index}', () => {
      // 0xed, 0x01 kind=global, uleb 300
      const loc = evalLocation(
        expr(C.DW_OP_WASM_location, 0x01, ...ULEB_300),
        undefined,
        mockState(),
      );
      const r = expect(loc, 'global');
      assert.strictEqual(r.index, INDEX);
    });

    it('kind 2 -> {stack, index}', () => {
      // 0xed, 0x02 kind=operand-stack, uleb 300
      const loc = evalLocation(
        expr(C.DW_OP_WASM_location, 0x02, ...ULEB_300),
        undefined,
        mockState(),
      );
      const r = expect(loc, 'stack');
      assert.strictEqual(r.index, INDEX);
    });
  });

  it('DW_OP_WASM_location kind 3 reads a FIXED u32 index (not ULEB)', () => {
    // Index 0x00000180 = 384, little-endian bytes [0x80, 0x01, 0x00, 0x00].
    // If mis-read as ULEB, the [0x80, 0x01] prefix would decode to 128 — so a
    // wrong index of 128 vs the correct fixed-u32 index of 384 catches the bug.
    // 0xed WASM_location, 0x03 kind=global-fixed-u32, 80 01 00 00 => 384
    const loc = evalLocation(
      expr(C.DW_OP_WASM_location, 0x03, 0x80, 0x01, 0x00, 0x00),
      undefined,
      mockState(),
    );
    const r = expect(loc, 'global');
    assert.strictEqual(r.index, 384);
    assert.notStrictEqual(r.index, 128); // would be the ULEB mis-decode
  });

  it('DW_OP_WASM_location with an unsupported kind -> {unavailable} (no throw)', () => {
    // 0xed, kind 0x07 (unsupported), index byte 0x00
    const loc = evalLocation(
      expr(C.DW_OP_WASM_location, 0x07, 0x00),
      undefined,
      mockState(),
    );
    expect(loc, 'unavailable');
  });

  describe('DW_OP_fbreg — frame-base-relative memory address', () => {
    it('frame base = WASM_location(local 3), offset -16 -> {memory, address: 984}', () => {
      // frameBaseExpr: 0xed WASM_location, 0x00 kind=local, 0x03 index 3
      const frameBase = expr(C.DW_OP_WASM_location, 0x00, 0x03);
      // expr: 0x91 fbreg, 0x70 = SLEB128(-16)
      const loc = evalLocation(
        expr(C.DW_OP_fbreg, 0x70),
        frameBase,
        mockState({ locals: { 3: 1000 } }),
      );
      const r = expect(loc, 'memory');
      assert.strictEqual(r.address, 984); // 1000 + (-16)
    });

    it('positive offset -> frameBaseValue + offset', () => {
      // frameBaseExpr: WASM_location local 3
      const frameBase = expr(C.DW_OP_WASM_location, 0x00, 0x03);
      // expr: 0x91 fbreg, 0x08 = SLEB128(+8)
      const loc = evalLocation(
        expr(C.DW_OP_fbreg, 0x08),
        frameBase,
        mockState({ locals: { 3: 1000 } }),
      );
      const r = expect(loc, 'memory');
      assert.strictEqual(r.address, 1008);
    });

    it('frame base = WASM_location kind 3 (global u32 0), offset +8 -> {memory, 65544}', () => {
      // frameBaseExpr: 0xed, 0x03 kind=global-fixed-u32, index 0 (00 00 00 00)
      const frameBase = expr(C.DW_OP_WASM_location, 0x03, 0x00, 0x00, 0x00, 0x00);
      // expr: 0x91 fbreg, 0x08 offset +8
      const loc = evalLocation(
        expr(C.DW_OP_fbreg, 0x08),
        frameBase,
        mockState({ globals: { 0: 65536 } }),
      );
      const r = expect(loc, 'memory');
      assert.strictEqual(r.address, 65544); // 65536 + 8
    });

    it('undefined frameBaseExpr -> {unavailable}', () => {
      // 0x91 fbreg, +8, but no frame base supplied.
      const loc = evalLocation(expr(C.DW_OP_fbreg, 0x08), undefined, mockState());
      expect(loc, 'unavailable');
    });

    it('frame-base register value undefined -> {unavailable}', () => {
      // frameBaseExpr references local 5, but the state has no value for local 5.
      const frameBase = expr(C.DW_OP_WASM_location, 0x00, 0x05);
      const loc = evalLocation(expr(C.DW_OP_fbreg, 0x08), frameBase, mockState({}));
      expect(loc, 'unavailable');
    });
  });

  describe('DW_OP_addr / DW_OP_plus_uconst', () => {
    it('DW_OP_addr pushes an address -> {memory}', () => {
      // 0x03 addr, 00 10 00 00 = 0x1000 (4096), addressSize 4
      const loc = evalLocation(expr(C.DW_OP_addr, 0x00, 0x10, 0x00, 0x00), undefined, mockState());
      const r = expect(loc, 'memory');
      assert.strictEqual(r.address, 0x1000);
    });

    it('DW_OP_addr then DW_OP_plus_uconst 4 -> address + 4', () => {
      // 0x03 addr 0x1000, 0x23 plus_uconst, 0x04 uleb 4
      const loc = evalLocation(
        expr(C.DW_OP_addr, 0x00, 0x10, 0x00, 0x00, C.DW_OP_plus_uconst, 0x04),
        undefined,
        mockState(),
      );
      const r = expect(loc, 'memory');
      assert.strictEqual(r.address, 0x1000 + 4);
    });
  });

  describe('lone register vs DW_OP_stack_value', () => {
    it('WASM_location(local 1) with no stack op -> the register location', () => {
      // 0xed, 0x00 kind=local, 0x01 index 1
      const loc = evalLocation(expr(C.DW_OP_WASM_location, 0x00, 0x01), undefined, mockState());
      const r = expect(loc, 'local');
      assert.strictEqual(r.index, 1);
    });

    it('DW_OP_addr 0x2a then DW_OP_stack_value -> {value, value: 42}', () => {
      // 0x03 addr, 2a 00 00 00 = 42, 0x9f stack_value
      const loc = evalLocation(
        expr(C.DW_OP_addr, 0x2a, 0x00, 0x00, 0x00, C.DW_OP_stack_value),
        undefined,
        mockState(),
      );
      const r = expect(loc, 'value');
      assert.strictEqual(r.value, 42);
    });
  });

  describe('graceful degradation (never throws)', () => {
    it('unknown opcode -> {unavailable}', () => {
      // 0xff is not a recognized opcode.
      let loc: ValueLocation | undefined;
      assert.doesNotThrow(() => {
        loc = evalLocation(expr(0xff), undefined, mockState());
      });
      expect(loc!, 'unavailable');
    });

    it('DW_OP_piece -> {unavailable}', () => {
      // 0x93 piece, 0x04 uleb size 4 — composite/piece is not assembled.
      let loc: ValueLocation | undefined;
      assert.doesNotThrow(() => {
        loc = evalLocation(expr(C.DW_OP_piece, 0x04), undefined, mockState());
      });
      expect(loc!, 'unavailable');
    });

    it('empty expression -> {unavailable}', () => {
      const loc = evalLocation(expr(), undefined, mockState());
      expect(loc, 'unavailable');
    });
  });
});

describe('dwarf/locexpr — registerValue', () => {
  it('reads local/global/stack slot integer values', () => {
    const state = mockState({ locals: { 3: 1000 }, globals: { 0: 65536 }, stacks: { 2: 7 } });
    assert.strictEqual(registerValue({ kind: 'local', index: 3 }, state), 1000);
    assert.strictEqual(registerValue({ kind: 'global', index: 0 }, state), 65536);
    assert.strictEqual(registerValue({ kind: 'stack', index: 2 }, state), 7);
  });

  it('coerces a bigint slot value to Number (frame bases are 32-bit)', () => {
    const state = mockState({ locals: { 1: 1234n } });
    assert.strictEqual(registerValue({ kind: 'local', index: 1 }, state), 1234);
  });

  it('returns undefined for a missing slot or a non-register location', () => {
    const state = mockState({});
    assert.strictEqual(registerValue({ kind: 'local', index: 9 }, state), undefined);
    assert.strictEqual(registerValue({ kind: 'memory', address: 0x1000 }, state), undefined);
    assert.strictEqual(registerValue({ kind: 'unavailable', reason: 'x' }, state), undefined);
  });
});
