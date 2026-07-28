/**
 * M2 acceptance tests: spec-driven arg encoding + `${...}` substitution.
 *
 * Pins the "M2 acceptance" section of the spec. Two pure, IO-free concerns
 * (aside from reading the committed wasm fixture off disk — no network, no
 * komet-node):
 *
 *   1. A spec-driven encoder (implementer's home: src/soroban/specEncode.ts):
 *      - `loadContractSpec(wasm)` resolves the contract `Spec` OFFLINE from the
 *        wasm's `contractspecv0` custom section.
 *      - `encodeNamedArgs(spec, fn, namedArgs)` encodes args keyed by the spec's
 *        EXACT param names, handling composites (vecs of tuples of unions).
 *      - `encodeInvokeArgs(spec, fn, args)` dispatches: a legacy `{type,value}[]`
 *        array routes to the existing `src/soroban/scval` encoder; an object
 *        routes to the spec-driven path.
 *   2. A pure `substitute(value, ctx)` pass replacing `${sourceAddress}` and
 *      `${contract:<id>}` inside string values.
 *
 * Uses the REAL committed fixture test/fixtures/composite.wasm (built from
 * test/fixtures/composite-contract/), whose `supply(requests: Vec<(AssetKey,
 * i128)>)` exercises union/tuple/vec encoding. Imports from the not-yet-existing
 * implementer module on purpose (TDD red phase).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Keypair, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  loadContractSpec,
  encodeNamedArgs,
  encodeInvokeArgs,
  substitute,
} from '../src/soroban/specEncode';

// Matches the loader used by the integration tests: compiled tests live in
// out/test/, so the fixture is two levels up under the source tree.
const COMPOSITE_WASM = path.join(__dirname, '..', '..', 'test', 'fixtures', 'composite.wasm');

// A deterministic, valid Stellar account address for the `Stellar(Address)`
// union variant. Derived from a fixed seed so the suite stays reproducible
// (no `Keypair.random()`), with no network access.
const ADDRESS = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();

type Spec = Awaited<ReturnType<typeof loadContractSpec>>;

describe('M2 specEncode', () => {
  let wasm: Buffer;
  let spec: Spec;

  before(async () => {
    wasm = fs.readFileSync(COMPOSITE_WASM);
    // Resolves fully OFFLINE — no RPC call, despite Client.fromWasm's rpc-shaped
    // signature (the spec is independent of any live contract id).
    spec = await loadContractSpec(wasm);
  });

  describe('loadContractSpec + encodeNamedArgs (spec-driven)', () => {
    it('encodes the composite `supply(requests: Vec<(AssetKey,i128)>)` to a top-level scvVec that round-trips to the exact native', () => {
      const scvals = encodeNamedArgs(spec, 'supply', {
        requests: [
          [{ tag: 'Native' }, '1000'],
          [{ tag: 'Other', values: [7] }, '-5'],
        ],
      });

      // A single top-level arg (`requests`), encoded as an ScVec.
      assert.strictEqual(scvals.length, 1);
      assert.strictEqual(scvals[0].switch().name, 'scvVec');

      // Round-trips to the EXACT native from the spec. i128 values decode to
      // bigint; the enum unit variant is `["Native"]`, the int variant carries
      // its payload as `["Other", 7]`.
      const native = scValToNative(scvals[0]);
      assert.deepStrictEqual(native, [
        [['Native'], 1000n],
        [['Other', 7], -5n],
      ]);
    });

    it('encodes a Stellar(Address) union variant', () => {
      const scvals = encodeNamedArgs(spec, 'supply', {
        requests: [[{ tag: 'Stellar', values: [ADDRESS] }, '42']],
      });

      assert.strictEqual(scvals.length, 1);
      assert.strictEqual(scvals[0].switch().name, 'scvVec');

      const native = scValToNative(scvals[0]);
      assert.deepStrictEqual(native, [[['Stellar', ADDRESS], 42n]]);
    });

    it('throws on a wrong param name', () => {
      assert.throws(() =>
        encodeNamedArgs(spec, 'supply', {
          // The spec's param is `requests`; a wrong name must be rejected
          // rather than silently dropped.
          wrongName: [[{ tag: 'Native' }, '1000']],
        }),
      );
    });

    it('throws on an unknown function', () => {
      assert.throws(() => encodeNamedArgs(spec, 'noSuchFunction', {}));
    });
  });

  describe('encodeInvokeArgs (dispatcher)', () => {
    it('routes a legacy `{type,value}[]` array to the legacy encoder', () => {
      const scvals = encodeInvokeArgs(spec, 'supply', [{ value: 5, type: 'u32' }]);
      assert.strictEqual(scvals.length, 1);
      assert.strictEqual(scvals[0].switch().name, 'scvU32');
      assert.strictEqual(Number(scValToNative(scvals[0])), 5);
    });

    it('routes an object of named args to the spec-driven encoder', () => {
      const scvals = encodeInvokeArgs(spec, 'supply', {
        requests: [[{ tag: 'Native' }, '1000']],
      });
      assert.strictEqual(scvals.length, 1);
      assert.strictEqual(scvals[0].switch().name, 'scvVec');
      assert.deepStrictEqual(scValToNative(scvals[0]), [[['Native'], 1000n]]);
    });

    it('produces xdr.ScVal instances on both paths', () => {
      const legacy = encodeInvokeArgs(spec, 'supply', [{ value: 1, type: 'u32' }]);
      const named = encodeInvokeArgs(spec, 'supply', {
        requests: [[{ tag: 'Native' }, '1']],
      });
      assert.ok(legacy[0] instanceof xdr.ScVal);
      assert.ok(named[0] instanceof xdr.ScVal);
    });
  });

  describe('substitute', () => {
    const ctx = {
      sourceAddress: 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57',
      contracts: { pool: 'CA24HSVRERTJMFUDSZXKFK2HMO5CBBK6U5KA6PLLL6BGSQRO44FYZFRE' },
    };

    it('replaces ${sourceAddress}', () => {
      assert.strictEqual(substitute('${sourceAddress}', ctx), ctx.sourceAddress);
    });

    it('replaces ${contract:<id>} with the resolved contract id', () => {
      assert.strictEqual(substitute('${contract:pool}', ctx), ctx.contracts.pool);
    });

    it('leaves a plain string unchanged', () => {
      assert.strictEqual(substitute('1000', ctx), '1000');
      assert.strictEqual(substitute('plain text', ctx), 'plain text');
    });

    it('passes non-string primitives through unchanged', () => {
      assert.strictEqual(substitute(5, ctx), 5);
      assert.strictEqual(substitute(true, ctx), true);
      assert.strictEqual(substitute(null, ctx), null);
    });

    it('recurses into arrays and objects, substituting only inside string values', () => {
      const input = {
        admin: '${sourceAddress}',
        requests: [['${contract:pool}', '5']],
      };
      assert.deepStrictEqual(substitute(input, ctx), {
        admin: ctx.sourceAddress,
        requests: [[ctx.contracts.pool, '5']],
      });
    });

    it('throws on an unknown ${...} token', () => {
      assert.throws(() => substitute('${bogus}', ctx));
    });

    it('throws on an unknown contract handle', () => {
      assert.throws(() => substitute('${contract:missing}', ctx));
    });
  });
});
