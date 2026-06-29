/**
 * Integration test for ContractBuilder against the real Rust + Stellar
 * toolchain. Skipped automatically when `stellar`/`cargo` are not on PATH so the
 * unit suite stays hermetic; runs in the devcontainer where the toolchain is
 * installed.
 */

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ContractBuilder } from '../src/build/ContractBuilder';

const CRATE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'sample-contract');

function hasTool(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const toolchainAvailable = hasTool('stellar') && hasTool('cargo');

(toolchainAvailable ? describe : describe.skip)('ContractBuilder (real toolchain)', function () {
  this.timeout(180_000);

  it('builds the sample contract to wasm and finds the artifact', async () => {
    const builder = new ContractBuilder();
    const wasmPath = await builder.build({ contractDir: CRATE }, () => undefined);

    assert.ok(wasmPath.endsWith('.wasm'), `expected a .wasm path, got ${wasmPath}`);
    const bytes = await fs.readFile(wasmPath);
    // wasm magic number: 0x00 0x61 0x73 0x6d
    assert.deepStrictEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  });

  it('returns a prebuilt wasm without building when wasmPath is given', async () => {
    const prebuilt = path.join(__dirname, '..', '..', 'test', 'fixtures', 'sample_contract.wasm');
    const builder = new ContractBuilder();
    const result = await builder.build({ contractDir: CRATE, wasmPath: prebuilt }, () => undefined);
    assert.strictEqual(result, prebuilt);
  });
});
