/**
 * Unit suite for the statement-stop declaration/brace filtering (docs/stepping.md
 * rules S17 and S18), at the lowest pure level: the two vscode-free functions in
 * src/debugAdapter/stops.ts that shape WHERE statement stepping comes to rest.
 *
 *   classifyLineRole(text): the role of a source line — 'attribute' (`#[..]` /
 *     `#![..]`, the #[contractimpl] export shim), 'signature' (an fn/impl/trait/
 *     mod item header), 'brace' (a lone closing brace), or 'statement'.
 *   statementStops(runStarts, depths, roleAt): the run starts that survive S17
 *     (drop declarations, but keep a declaration that is its frame's sole stop)
 *     and S18 (drop inner braces, keep the function's final epilogue brace),
 *     never returning empty for non-empty input.
 *
 * These are the contract the higher-level model/DAP suites build on; the
 * implementation does not exist yet, so this file is the red anchor for it.
 */

import * as assert from 'assert';
import { classifyLineRole, statementStops, LineRole } from '../src/debugAdapter/stops';

describe('classifyLineRole (docs/stepping.md S17/S18)', () => {
  const role = (text: string | null): LineRole => classifyLineRole(text);

  it('maps a null line (no source text) to a statement', () => {
    assert.strictEqual(role(null), 'statement');
  });

  it('classifies attribute lines (#[..] and #![..], with leading whitespace)', () => {
    for (const text of [
      '#[contractimpl]',
      '#[contract]',
      '#[inline(never)]',
      '#[test]',
      '#![no_std]',
      '    #[contractimpl]',
      '\t#![no_main]',
    ]) {
      assert.strictEqual(role(text), 'attribute', `expected attribute for ${JSON.stringify(text)}`);
    }
  });

  it('classifies fn item headers with every documented qualifier', () => {
    for (const text of [
      'fn triple(x: u32) -> u32 {',
      'pub fn add(_env: Env, a: u32, b: u32) -> u32 {',
      'pub(crate) fn helper() {',
      'const fn c() -> u32 {',
      'async fn a() {',
      'unsafe fn u() {',
      'extern fn e() {',
      'extern "C" fn ec() {',
      '    pub fn seq(_env: Env, x: u32) -> u32 {',
    ]) {
      assert.strictEqual(role(text), 'signature', `expected signature for ${JSON.stringify(text)}`);
    }
  });

  it('classifies impl / trait / mod item headers', () => {
    for (const text of ['impl Adder {', 'impl Control {', 'trait Shape {', 'mod tests {']) {
      assert.strictEqual(role(text), 'signature', `expected signature for ${JSON.stringify(text)}`);
    }
  });

  it('classifies lone closing braces (}, };, },) with leading whitespace', () => {
    for (const text of ['}', '};', '},', '    }', '\t\t};', '        },']) {
      assert.strictEqual(role(text), 'brace', `expected brace for ${JSON.stringify(text)}`);
    }
  });

  it('classifies real statements and expressions as statements', () => {
    for (const text of [
      'let doubled = x.wrapping_mul(2);',
      'let mut acc: u32 = 0;',
      'if 3 <= 10 {',
      'for i in 0..3 {',
      'while i < n {',
      'match x % 3 {',
      'acc = acc.wrapping_add(triple(i));',
      'a + b',
      'c',
      'return x;',
      'use soroban_sdk::contractimpl;',
    ]) {
      assert.strictEqual(role(text), 'statement', `expected statement for ${JSON.stringify(text)}`);
    }
  });

  it('does not mistake a struct header or an identifier prefix for an item header', () => {
    // struct is deliberately NOT in the item-header set (only fn/impl/trait/mod).
    assert.strictEqual(role('pub struct Adder;'), 'statement');
    // Word-boundary: a call/identifier that merely starts with fn/mod is glue.
    assert.strictEqual(role('functional();'), 'statement');
    assert.strictEqual(role('moderate = 1;'), 'statement');
    // A brace with trailing code is not a lone brace.
    assert.strictEqual(role('} else {'), 'statement');
  });
});

describe('statementStops (docs/stepping.md S17/S18)', () => {
  /**
   * Run the filter with `depths`/`roles` indexed by trace index (the values in
   * `runStarts` index into them), matching the reference algorithm's roleAt.
   */
  function filter(runStarts: number[], depths: number[], roles: LineRole[]): number[] {
    return statementStops(runStarts, depths, (i) => roles[i]);
  }

  it('S17: drops attribute run starts, keeps statements', () => {
    // Two run starts at the same depth: the #[contractimpl]-style attribute is
    // glue, the statement is a stop.
    assert.deepStrictEqual(filter([0, 1], [2, 2], ['attribute', 'statement']), [1]);
  });

  it('S17: drops the export shim around a single body statement (adder shape)', () => {
    // 6 (:12 #[contractimpl]) / 29 (:16 body) / 40 (:12 shim epilogue) → only 29.
    const depths = [];
    const roles: LineRole[] = [];
    depths[6] = 0;
    roles[6] = 'attribute';
    depths[29] = 0;
    roles[29] = 'statement';
    depths[40] = 0;
    roles[40] = 'attribute';
    assert.deepStrictEqual(filter([6, 29, 40], depths, roles), [29]);
  });

  it('S18: drops an inner brace but keeps the function-final (epilogue) brace', () => {
    // depth-2 frame: statement, inner brace (followed by same depth), final
    // brace (followed by the shallower depth-1 caller), then the caller stmt.
    assert.deepStrictEqual(
      filter([0, 1, 2, 3], [2, 2, 2, 1], ['statement', 'brace', 'brace', 'statement']),
      [0, 2, 3],
    );
  });

  it('S18: keeps a brace that is the very last run start (nothing follows)', () => {
    assert.deepStrictEqual(filter([0, 1], [2, 2], ['statement', 'brace']), [0, 1]);
  });

  it('S17: drops a signature that has a later same-depth statement stop', () => {
    assert.deepStrictEqual(filter([0, 1], [2, 2], ['signature', 'statement']), [1]);
  });

  it('S17: drops a signature that appears AFTER a same-depth body statement (frame epilogue)', () => {
    // The depth-2 frame already has a body statement (index 0) BEFORE the
    // signature run start (index 1); index 2 returns to the shallower depth-1
    // caller. The signature is not its frame's sole stop, so it is dropped —
    // this is the frame-epilogue-attributed-to-the-signature case the reviewer
    // flagged. A forward-only look-ahead (which only sees the shallower index 2
    // after the signature) would wrongly keep it; the contract is "the ONLY run
    // start of its frame", judged in BOTH directions.
    assert.deepStrictEqual(
      filter([0, 1, 2], [2, 2, 1], ['statement', 'signature', 'statement']),
      [0, 2],
    );
  });

  it('S17: drops a signature whose only later same-depth stop is a kept (final) brace', () => {
    // signature(d2), final brace(d2, followed by shallower d1), caller stmt(d1).
    assert.deepStrictEqual(
      filter([0, 1, 2], [2, 2, 1], ['signature', 'brace', 'statement']),
      [1, 2],
    );
  });

  it('S17 exception: keeps a signature that is its frame\'s sole stop (collapsed fn)', () => {
    // signature at depth 3 with the frame returning immediately (next run start
    // is shallower) — the fully collapsed one-line fn still needs a step-in
    // target, so it is kept (stepper `triple` shape).
    assert.deepStrictEqual(
      filter([0, 1, 2], [2, 3, 2], ['statement', 'signature', 'statement']),
      [0, 1, 2],
    );
  });

  it('S17 exception: keeps a signature when its only same-depth follower is a suppressed inner brace', () => {
    // signature(d2); inner brace(d2, NOT final — followed by deeper d3); a
    // deeper statement(d3); then the frame returns (d1). The brace does not
    // count as a same-depth stop, so the signature is its frame's sole stop.
    assert.deepStrictEqual(
      filter([0, 1, 2, 3], [2, 2, 3, 1], ['signature', 'brace', 'statement', 'statement']),
      [0, 2, 3],
    );
  });

  it('S17 exception never applies to attribute lines (shim is always glue)', () => {
    // A lone attribute run start in a frame — dropped, not kept as sole stop —
    // as long as another stop survives elsewhere (global safety not triggered).
    assert.deepStrictEqual(
      filter([0, 1, 2], [2, 3, 2], ['statement', 'attribute', 'statement']),
      [0, 2],
    );
  });

  it('keeps three collapsed-fn signatures across repeated depth-1 visits (stepper triple)', () => {
    // Raw stepper run starts (index@depth): 5@0(attr) 21@0 27@0 29@1(sig) 39@0
    // 44@0 46@1(sig) 56@0 61@0 63@1(sig) 73@0 84@0(attr). Each :15 signature is
    // the sole stop of its (repeated) depth-1 frame → all three kept; shim and
    // epilogue attributes dropped.
    const runStarts = [5, 21, 27, 29, 39, 44, 46, 56, 61, 63, 73, 84];
    const depths: number[] = [];
    const roles: LineRole[] = [];
    const set = (i: number, d: number, r: LineRole) => {
      depths[i] = d;
      roles[i] = r;
    };
    set(5, 0, 'attribute');
    set(21, 0, 'statement');
    set(27, 0, 'statement');
    set(29, 1, 'signature');
    set(39, 0, 'statement');
    set(44, 0, 'statement');
    set(46, 1, 'signature');
    set(56, 0, 'statement');
    set(61, 0, 'statement');
    set(63, 1, 'signature');
    set(73, 0, 'statement');
    set(84, 0, 'attribute');
    assert.deepStrictEqual(filter(runStarts, depths, roles), [21, 27, 29, 39, 44, 46, 56, 61, 63, 73]);
  });

  it('global safety: never returns empty for non-empty input', () => {
    // Everything is a declaration → filtering would empty the trace, so the
    // unfiltered run starts stand (preserving S1/S2/S3).
    assert.deepStrictEqual(filter([0], [2], ['attribute']), [0]);
    assert.deepStrictEqual(filter([0, 1], [0, 1], ['attribute', 'attribute']), [0, 1]);
  });

  it('returns an empty array unchanged (wasm-less replay has no run starts)', () => {
    assert.deepStrictEqual(filter([], [], []), []);
  });
});
