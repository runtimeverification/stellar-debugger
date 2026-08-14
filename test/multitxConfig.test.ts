/**
 * Acceptance tests for the multi-transaction debug-config normalizer.
 *
 * Pins a PURE function `normalizeConfig(raw)` (implementer's home:
 * src/pipeline/config.ts) that turns the single `transactions` + `trace` schema
 * into one canonical `{ steps, trace }` shape, with the listed validation
 * rejections. There is exactly ONE live config format: an ordered, non-empty
 * `transactions` array (the legacy single-invoke top-level config has been
 * REMOVED).
 *
 * This module is intentionally IO-free (no network, no filesystem) so the suite
 * is deterministic.
 */

import * as assert from 'assert';
import { normalizeConfig } from '../src/pipeline/config';

// --- Canonical shape this milestone pins -----------------------------------
// The normalizer's output is an ordered `steps` array plus a `trace` selector
// RESOLVED to a 0-based position (index into `steps`) per spec point 3
// ("Resolves trace:'last' to the last step's position").

interface DeployStep {
  kind: 'deploy';
  id: string;
  /** Prebuilt `.wasm` path. */
  wasm?: string;
  /** Contract crate dir (built to a wasm). */
  contract?: string;
  /** OPTIONAL: build command threaded into a `contract`-dir build. */
  buildCommand?: string;
  /** OPTIONAL: inject DWARF debug info when building from a crate dir. */
  debugInfo?: boolean;
}

interface InvokeStep {
  kind: 'invoke';
  /** Handle id referencing a prior deploy step (NOT yet a live contractId). */
  contract: string;
  function: string;
  /** A named object keyed by spec param names, or the positional `{type,value}[]` encoding. Passed through untouched. */
  args?: unknown;
  /** OPTIONAL: a trace selector may match this invoke id. */
  id?: string;
}

type TxStep = DeployStep | InvokeStep;

interface Normalized {
  steps: TxStep[];
  trace: number;
}

/** Robust boundary cast: the implementer owns the concrete types. */
function norm(raw: unknown): Normalized {
  return normalizeConfig(raw as never) as unknown as Normalized;
}

describe('normalizeConfig', () => {
  // ------------------------------------------------------------------------
  // 1. New `transactions` + `trace` schema → canonical steps, in order.
  // ------------------------------------------------------------------------
  describe('new transactions schema (happy path)', () => {
    const raw = {
      type: 'soroban',
      request: 'launch',
      transactions: [
        { kind: 'deploy', id: 'pool', wasm: '/abs/pool.wasm' },
        {
          kind: 'invoke',
          contract: 'pool',
          function: '__constructor',
          args: { admin: '${sourceAddress}' },
        },
        {
          kind: 'invoke',
          contract: 'pool',
          function: 'supply',
          args: { requests: [[{ tag: 'Native' }, '1000']] },
        },
      ],
      trace: 'last',
    };

    it('produces one canonical step per transaction, in submission order', () => {
      const { steps } = norm(raw);
      assert.strictEqual(steps.length, 3);
      assert.deepStrictEqual(
        steps.map((s) => s.kind),
        ['deploy', 'invoke', 'invoke'],
      );
    });

    it('preserves the deploy handle id and its wasm source', () => {
      const deploy = norm(raw).steps[0] as DeployStep;
      assert.strictEqual(deploy.kind, 'deploy');
      assert.strictEqual(deploy.id, 'pool');
      assert.strictEqual(deploy.wasm, '/abs/pool.wasm');
    });

    it('keeps invoke function, handle ref and named args verbatim (no encoding here)', () => {
      const invoke = norm(raw).steps[2] as InvokeStep;
      assert.strictEqual(invoke.kind, 'invoke');
      assert.strictEqual(invoke.contract, 'pool');
      assert.strictEqual(invoke.function, 'supply');
      assert.deepStrictEqual(invoke.args, { requests: [[{ tag: 'Native' }, '1000']] });
    });

    it('resolves the invoke handle references against earlier deploys without error', () => {
      // A well-formed sequence (both invokes reference the `pool` deploy) must
      // normalize cleanly.
      assert.doesNotThrow(() => norm(raw));
    });
  });

  // ------------------------------------------------------------------------
  // 2. Trace selector resolution: "last" | index | id → 0-based position.
  // ------------------------------------------------------------------------
  describe('trace selector resolution', () => {
    const threeSteps = {
      type: 'soroban',
      request: 'launch',
      transactions: [
        { kind: 'deploy', id: 'a', wasm: '/a.wasm' },
        { kind: 'deploy', id: 'b', wasm: '/b.wasm' },
        { kind: 'invoke', contract: 'a', function: 'run' },
      ],
    };

    it('resolves "last" to the last step position', () => {
      const { steps, trace } = norm({ ...threeSteps, trace: 'last' });
      assert.strictEqual(typeof trace, 'number');
      assert.strictEqual(trace, steps.length - 1);
      assert.strictEqual(trace, 2);
    });

    it('defaults to "last" when `trace` is omitted', () => {
      assert.strictEqual(norm(threeSteps).trace, 2);
    });

    it('accepts a 0-based integer index selector', () => {
      assert.strictEqual(norm({ ...threeSteps, trace: 0 }).trace, 0);
      assert.strictEqual(norm({ ...threeSteps, trace: 1 }).trace, 1);
    });

    it('accepts a tx id string selector, resolving it to that step position', () => {
      assert.strictEqual(norm({ ...threeSteps, trace: 'a' }).trace, 0);
      assert.strictEqual(norm({ ...threeSteps, trace: 'b' }).trace, 1);
    });
  });

  // ------------------------------------------------------------------------
  // 3. Validation rejections.
  // ------------------------------------------------------------------------
  describe('validation rejections', () => {
    it('rejects an empty `transactions` array', () => {
      assert.throws(() =>
        norm({ type: 'soroban', request: 'launch', transactions: [] }),
      );
    });

    it('rejects an invoke referencing an unknown deploy id', () => {
      assert.throws(
        () =>
          norm({
            type: 'soroban',
            request: 'launch',
            transactions: [
              { kind: 'deploy', id: 'pool', wasm: '/p.wasm' },
              { kind: 'invoke', contract: 'ghost', function: 'run' },
            ],
          }),
        /ghost/,
      );
    });

    it('rejects a duplicate deploy id', () => {
      assert.throws(
        () =>
          norm({
            type: 'soroban',
            request: 'launch',
            transactions: [
              { kind: 'deploy', id: 'dup', wasm: '/a.wasm' },
              { kind: 'deploy', id: 'dup', wasm: '/b.wasm' },
            ],
          }),
        /dup/,
      );
    });

    it('rejects a trace index that is out of range', () => {
      assert.throws(() =>
        norm({
          type: 'soroban',
          request: 'launch',
          transactions: [
            { kind: 'deploy', id: 'a', wasm: '/a.wasm' },
            { kind: 'invoke', contract: 'a', function: 'run' },
          ],
          trace: 99,
        }),
      );
    });

    it('rejects a trace id that names no transaction', () => {
      assert.throws(
        () =>
          norm({
            type: 'soroban',
            request: 'launch',
            transactions: [
              { kind: 'deploy', id: 'a', wasm: '/a.wasm' },
              { kind: 'invoke', contract: 'a', function: 'run' },
            ],
            trace: 'nope',
          }),
        /nope/,
      );
    });

    it('rejects a config with no `transactions` array', () => {
      assert.throws(() => norm({ type: 'soroban', request: 'launch' }));
    });

    it('rejects a leftover legacy top-level `function` with a migration error', () => {
      // The legacy single-invoke config was REMOVED. This config is WELL-FORMED
      // by the OLD rules (a `function` + a `wasmPath` source the old desugar
      // would have ACCEPTED), so it distinguishes new behavior from old: under
      // the removed legacy path it normalized cleanly; now it must fail with a
      // clear migration message pointing at the `transactions` array.
      assert.throws(
        () =>
          norm({
            type: 'soroban',
            request: 'launch',
            function: 'add',
            args: [{ value: 1, type: 'u32' }],
            wasmPath: '/abs/x.wasm',
          }),
        /legacy|transactions/i,
      );
    });

    it('rejects a stray legacy top-level `function` even when `transactions` is present', () => {
      // A half-migrated config (a valid `transactions` array plus a leftover
      // top-level `function`) must be caught, not silently misread by ignoring
      // the stray `function`.
      assert.throws(
        () =>
          norm({
            type: 'soroban',
            request: 'launch',
            function: 'add',
            transactions: [
              { kind: 'deploy', id: 'a', wasm: '/a.wasm' },
              { kind: 'invoke', contract: 'a', function: 'run' },
            ],
          }),
        /legacy|transactions/i,
      );
    });
  });

  // ------------------------------------------------------------------------
  // 4. Purity: same input in, same output out; no shared mutable state.
  // ------------------------------------------------------------------------
  describe('purity', () => {
    it('is referentially transparent for the same input', () => {
      const raw = {
        type: 'soroban',
        request: 'launch',
        transactions: [
          { kind: 'deploy', id: 'pool', wasm: '/p.wasm' },
          { kind: 'invoke', contract: 'pool', function: 'run', args: { x: '1' } },
        ],
      };
      assert.deepStrictEqual(norm(raw), norm(raw));
    });

    it('does not mutate the input config', () => {
      const raw = {
        type: 'soroban',
        request: 'launch',
        transactions: [
          { kind: 'deploy', id: 'pool', wasm: '/p.wasm' },
          { kind: 'invoke', contract: 'pool', function: 'run' },
        ],
        trace: 'last',
      };
      const snapshot = JSON.parse(JSON.stringify(raw));
      norm(raw);
      assert.deepStrictEqual(raw, snapshot);
    });
  });

  // ------------------------------------------------------------------------
  // 5. Optional invoke `id` + trace-by-invoke-id.
  //    An invoke MAY carry an `id`; the `trace` string selector then matches an
  //    invoke id, not just a deploy id. All existing selector behaviour stays.
  // ------------------------------------------------------------------------
  describe('optional invoke id + trace-by-invoke-id', () => {
    const raw = {
      type: 'soroban',
      request: 'launch',
      transactions: [
        { kind: 'deploy', id: 'pool', wasm: '/p.wasm' },
        {
          kind: 'invoke',
          id: 'ctor',
          contract: 'pool',
          function: '__constructor',
          args: { admin: '${sourceAddress}' },
        },
        { kind: 'invoke', id: 'go', contract: 'pool', function: 'supply' },
      ],
    };

    it('preserves an optional invoke `id` on the canonical step', () => {
      const invoke = norm(raw).steps[1] as InvokeStep;
      assert.strictEqual(invoke.kind, 'invoke');
      assert.strictEqual(invoke.id, 'ctor');
    });

    it('leaves an invoke without an `id` as undefined (id is optional)', () => {
      const bare = norm({
        type: 'soroban',
        request: 'launch',
        transactions: [
          { kind: 'deploy', id: 'pool', wasm: '/p.wasm' },
          { kind: 'invoke', contract: 'pool', function: 'run' },
        ],
      });
      const invoke = bare.steps[1] as InvokeStep;
      assert.strictEqual(invoke.kind, 'invoke');
      assert.strictEqual(invoke.id, undefined);
    });

    it('resolves a `trace` string that matches an invoke id to that step position', () => {
      assert.strictEqual(norm({ ...raw, trace: 'ctor' }).trace, 1);
      assert.strictEqual(norm({ ...raw, trace: 'go' }).trace, 2);
    });

    it('still resolves a `trace` string that matches a deploy id (unchanged)', () => {
      assert.strictEqual(norm({ ...raw, trace: 'pool' }).trace, 0);
    });

    it('rejects a `trace` id matching neither a deploy nor an invoke id', () => {
      assert.throws(() => norm({ ...raw, trace: 'ghost' }), /ghost/);
    });
  });

  // ------------------------------------------------------------------------
  // 6. DeployStep carries optional build controls (buildCommand + debugInfo)
  //    so a `contract`-dir build keeps its build command + debug-info injection.
  // ------------------------------------------------------------------------
  describe('deploy build options: buildCommand + debugInfo', () => {
    it('preserves `buildCommand` + `debugInfo` declared on a new-schema deploy step', () => {
      const deploy = norm({
        type: 'soroban',
        request: 'launch',
        transactions: [
          {
            kind: 'deploy',
            id: 'pool',
            contract: '/abs/pool',
            buildCommand: 'cargo build',
            debugInfo: false,
          },
          { kind: 'invoke', contract: 'pool', function: 'run' },
        ],
      }).steps[0] as DeployStep;

      assert.strictEqual(deploy.buildCommand, 'cargo build');
      assert.strictEqual(deploy.debugInfo, false);
    });
  });
});
