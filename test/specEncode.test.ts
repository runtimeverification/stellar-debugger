/**
 * M2 acceptance tests: spec-driven arg encoding + `${...}` substitution.
 *
 * Two pure, IO-free concerns (aside from reading the committed wasm fixture off
 * disk — no network, no komet-node):
 *
 *   1. `encodeInvokeArgs(wasm, fn, args)` encodes args keyed by the contract
 *      spec's EXACT param names, parsing the wasm's `contractspecv0` custom
 *      section OFFLINE and handling composites (vecs of tuples of unions).
 *   2. A pure `substitute(value, ctx)` pass replacing `${sourceAddress}` and
 *      `${contract:<id>}` inside string values.
 *
 * Uses the REAL committed fixture test/fixtures/composite.wasm (built from
 * test/fixtures/composite-contract/), whose `supply(requests: Vec<(AssetKey,
 * i128)>)` exercises union/tuple/vec encoding.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Keypair, scValToNative, xdr } from '@stellar/stellar-sdk';
import { encodeInvokeArgs, substitute } from '../src/soroban/specEncode';

// Matches the loader used by the integration tests: compiled tests live in
// out/test/, so the fixture is two levels up under the source tree.
const COMPOSITE_WASM = path.join(__dirname, '..', '..', 'test', 'fixtures', 'composite.wasm');

// A deterministic, valid Stellar account address for the `Stellar(Address)`
// union variant. Derived from a fixed seed so the suite stays reproducible
// (no `Keypair.random()`), with no network access.
const ADDRESS = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();

describe('M2 specEncode', () => {
  let wasm: Buffer;

  before(() => {
    // Read once; every encode below parses its `contractspecv0` section fully
    // OFFLINE — no RPC call, despite Spec.fromWasm's rpc-shaped signature.
    wasm = fs.readFileSync(COMPOSITE_WASM);
  });

  describe('spec-driven encoding', () => {
    it('encodes the composite `supply(requests: Vec<(AssetKey,i128)>)` to a top-level scvVec that round-trips to the exact native', async () => {
      const scvals = await encodeInvokeArgs(wasm, 'supply', {
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

    it('encodes a Stellar(Address) union variant', async () => {
      const scvals = await encodeInvokeArgs(wasm, 'supply', {
        requests: [[{ tag: 'Stellar', values: [ADDRESS] }, '42']],
      });

      assert.strictEqual(scvals.length, 1);
      assert.strictEqual(scvals[0].switch().name, 'scvVec');

      const native = scValToNative(scvals[0]);
      assert.deepStrictEqual(native, [[['Stellar', ADDRESS], 42n]]);
    });

    it('rejects a wrong param name', async () => {
      await assert.rejects(
        // The spec's param is `requests`; a wrong name must be rejected rather
        // than silently dropped.
        encodeInvokeArgs(wasm, 'supply', { wrongName: [[{ tag: 'Native' }, '1000']] }),
      );
    });

    it('rejects an unknown function', async () => {
      await assert.rejects(encodeInvokeArgs(wasm, 'noSuchFunction', {}));
    });

    it('encodes no arguments at all when the step states none', async () => {
      assert.deepStrictEqual(await encodeInvokeArgs(wasm, 'supply', undefined), []);
    });

    it('rejects the positional array form, which the spec-driven schema replaced', async () => {
      await assert.rejects(encodeInvokeArgs(wasm, 'supply', [{ value: 5, type: 'u32' }]), /object/);
    });

    it('produces xdr.ScVal instances', async () => {
      const named = await encodeInvokeArgs(wasm, 'supply', {
        requests: [[{ tag: 'Native' }, '1']],
      });
      assert.ok(named[0] instanceof xdr.ScVal);
    });
  });

  describe('event (kind-5) spec entries', () => {
    // Guards parsing of protocol-23 `SC_SPEC_ENTRY_EVENT_V0` (kind 5) spec
    // entries. The pre-14 `@stellar/stellar-sdk` rejected any wasm whose
    // `contractspecv0` section held one with:
    //   "XDR Read Error: unknown ScSpecEntryKind member for value 5".
    // This self-contained 81-byte wasm is the 8-byte header + a single
    // `contractspecv0` custom section holding
    //   [ScSpecEntryFunctionV0 "noop", ScSpecEntryEventV0 "evt"]
    // and leaks nothing from any real project.
    const EVENT_SPEC_WASM = Buffer.from(
      'AGFzbQEAAAAARw5jb250cmFjdHNwZWN2MAAAAAAAAAAAAAAABG5vb3AAAAAAAAAAAAAAAAUAAAAAAAAAAAAAAANldnQAAAAAAAAAAAAAAAAA',
      'base64',
    );

    it('parses a spec containing a kind-5 event entry without throwing', async () => {
      // `noop` takes no args, so a successful encode proves the whole spec —
      // event entry included — parsed.
      assert.deepStrictEqual(await encodeInvokeArgs(EVENT_SPEC_WASM, 'noop', {}), []);
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
