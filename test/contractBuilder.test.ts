import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContractBuilder } from '../src/build/ContractBuilder';
import { TROUBLESHOOTING_URL, isUserFacing } from '../src/diagnostics/setup';
import { WASM_HEADER, customSection, wasmModule } from './support/wasmBytes';

const DEPS_REL = path.join('target', 'wasm32v1-none', 'release', 'deps');
const RELEASE_REL = path.join('target', 'wasm32v1-none', 'release');

const MINIMAL_WASM = Uint8Array.from(WASM_HEADER);
const DEBUG_LINE_WASM = wasmModule(customSection('.debug_line', [1, 2, 3, 4]));

/**
 * Build command that records the DWARF-related cargo env vars into env.txt in
 * the contract dir and drops a minimal wasm into release/deps so findWasm
 * succeeds. Single-quoted for the POSIX shell used by ContractBuilder.run;
 * the JS string escapes use double quotes only.
 */
const ENV_RECORDING_COMMAND =
  `node -e '` +
  `const fs=require("fs");` +
  `fs.mkdirSync("target/wasm32v1-none/release/deps",{recursive:true});` +
  `fs.writeFileSync("env.txt",` +
  `String(process.env.CARGO_PROFILE_RELEASE_DEBUG)+"\\n"+String(process.env.CARGO_PROFILE_RELEASE_STRIP));` +
  `fs.writeFileSync("target/wasm32v1-none/release/deps/x.wasm",Buffer.from([0,97,115,109,1,0,0,0]));` +
  `'`;

/**
 * Like ENV_RECORDING_COMMAND but records all THREE DWARF-related cargo env vars
 * into env.txt (DEBUG, STRIP, OPT_LEVEL — one per line) so a single build can
 * assert on the whole trio. opt-level=0 is what preserves per-statement line
 * info for source stepping (see docs/stepping.md "Build prerequisite").
 */
const ENV_RECORDING_COMMAND_ALL =
  `node -e '` +
  `const fs=require("fs");` +
  `fs.mkdirSync("target/wasm32v1-none/release/deps",{recursive:true});` +
  `fs.writeFileSync("env.txt",` +
  `String(process.env.CARGO_PROFILE_RELEASE_DEBUG)+"\\n"+` +
  `String(process.env.CARGO_PROFILE_RELEASE_STRIP)+"\\n"+` +
  `String(process.env.CARGO_PROFILE_RELEASE_OPT_LEVEL));` +
  `fs.writeFileSync("target/wasm32v1-none/release/deps/x.wasm",Buffer.from([0,97,115,109,1,0,0,0]));` +
  `'`;

describe('ContractBuilder (unit, temp dirs)', () => {
  const tempDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  before(() => {
    for (const key of [
      'CARGO_PROFILE_RELEASE_DEBUG',
      'CARGO_PROFILE_RELEASE_STRIP',
      'CARGO_PROFILE_RELEASE_OPT_LEVEL',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function makeContractDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-builder-test-'));
    tempDirs.push(dir);
    return dir;
  }

  async function writeWasm(dir: string, rel: string, bytes: Uint8Array): Promise<string> {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, bytes);
    return full;
  }

  function collector(): { messages: string[]; report: (m: string) => void } {
    const messages: string[] = [];
    return { messages, report: (m: string) => messages.push(m) };
  }

  describe('debug-info env injection', () => {
    it('injects CARGO_PROFILE_RELEASE_DEBUG=true and CARGO_PROFILE_RELEASE_STRIP=none by default', async () => {
      const dir = await makeContractDir();
      const builder = new ContractBuilder();
      await builder.build({ contractDir: dir, buildCommand: ENV_RECORDING_COMMAND }, () => undefined);

      const recorded = await fs.readFile(path.join(dir, 'env.txt'), 'utf8');
      assert.strictEqual(recorded, 'true\nnone');
    });

    it('does not inject the env vars when debugInfo is false', async () => {
      const dir = await makeContractDir();
      const builder = new ContractBuilder();
      await builder.build(
        { contractDir: dir, buildCommand: ENV_RECORDING_COMMAND, debugInfo: false },
        () => undefined,
      );

      const recorded = await fs.readFile(path.join(dir, 'env.txt'), 'utf8');
      assert.strictEqual(recorded, 'undefined\nundefined');
    });

    // opt-level=0 is the third DWARF-related var: at any higher level the line
    // table collapses whole functions onto one source line and source stepping
    // becomes a no-op (docs/stepping.md "Build prerequisite: optimization
    // level"). It must be injected alongside DEBUG/STRIP under the same
    // debugInfo!==false guard.
    it('injects CARGO_PROFILE_RELEASE_OPT_LEVEL=0 by default', async () => {
      const dir = await makeContractDir();
      const builder = new ContractBuilder();
      await builder.build({ contractDir: dir, buildCommand: ENV_RECORDING_COMMAND_ALL }, () => undefined);

      const recorded = await fs.readFile(path.join(dir, 'env.txt'), 'utf8');
      assert.strictEqual(recorded, 'true\nnone\n0');
    });

    it('injects none of the three cargo env vars when debugInfo is false', async () => {
      const dir = await makeContractDir();
      const builder = new ContractBuilder();
      await builder.build(
        { contractDir: dir, buildCommand: ENV_RECORDING_COMMAND_ALL, debugInfo: false },
        () => undefined,
      );

      const recorded = await fs.readFile(path.join(dir, 'env.txt'), 'utf8');
      assert.strictEqual(recorded, 'undefined\nundefined\nundefined');
    });
  });

  describe('findWasm deps/ preference', () => {
    it('prefers the deps/ wasm even when a release/ wasm is newer', async () => {
      const dir = await makeContractDir();
      const depsWasm = await writeWasm(dir, path.join(DEPS_REL, 'a.wasm'), MINIMAL_WASM);
      const releaseWasm = await writeWasm(dir, path.join(RELEASE_REL, 'b.wasm'), MINIMAL_WASM);
      const old = new Date(Date.now() - 100_000);
      const fresh = new Date();
      await fs.utimes(depsWasm, old, old);
      await fs.utimes(releaseWasm, fresh, fresh);

      const builder = new ContractBuilder();
      const result = await builder.build({ contractDir: dir, buildCommand: 'true' }, () => undefined);
      assert.strictEqual(result, depsWasm);
    });

    it('falls back to release/*.wasm when deps/ has no wasm', async () => {
      const dir = await makeContractDir();
      await fs.mkdir(path.join(dir, DEPS_REL), { recursive: true });
      const releaseWasm = await writeWasm(dir, path.join(RELEASE_REL, 'b.wasm'), MINIMAL_WASM);

      const builder = new ContractBuilder();
      const result = await builder.build({ contractDir: dir, buildCommand: 'true' }, () => undefined);
      assert.strictEqual(result, releaseWasm);
    });
  });

  describe('missing .debug_line warning', () => {
    it('warns about missing debug info when the built wasm has no .debug_line section', async () => {
      const dir = await makeContractDir();
      await writeWasm(dir, path.join(DEPS_REL, 'a.wasm'), MINIMAL_WASM);

      const { messages, report } = collector();
      const builder = new ContractBuilder();
      await builder.build({ contractDir: dir, buildCommand: 'true' }, report);
      assert.ok(
        messages.some((m) => /debug info/i.test(m)),
        `expected a warning mentioning debug info, got: ${JSON.stringify(messages)}`,
      );
    });

    it('does not warn when the built wasm has a .debug_line section', async () => {
      const dir = await makeContractDir();
      await writeWasm(dir, path.join(DEPS_REL, 'a.wasm'), DEBUG_LINE_WASM);

      const { messages, report } = collector();
      const builder = new ContractBuilder();
      await builder.build({ contractDir: dir, buildCommand: 'true' }, report);
      assert.ok(
        !messages.some((m) => /debug info/i.test(m)),
        `expected no debug-info warning, got: ${JSON.stringify(messages)}`,
      );
    });

    it('does not warn when debugInfo is false', async () => {
      const dir = await makeContractDir();
      await writeWasm(dir, path.join(DEPS_REL, 'a.wasm'), MINIMAL_WASM);

      const { messages, report } = collector();
      const builder = new ContractBuilder();
      await builder.build({ contractDir: dir, buildCommand: 'true', debugInfo: false }, report);
      assert.ok(
        !messages.some((m) => /debug info/i.test(m)),
        `expected no debug-info warning, got: ${JSON.stringify(messages)}`,
      );
    });

    it('never fails the build when the wasm is malformed; it only warns', async () => {
      const dir = await makeContractDir();
      const malformed = await writeWasm(
        dir,
        path.join(DEPS_REL, 'a.wasm'),
        Uint8Array.from(Buffer.from('this is not a wasm module')),
      );

      const builder = new ContractBuilder();
      const result = await builder.build({ contractDir: dir, buildCommand: 'true' }, () => undefined);
      assert.strictEqual(result, malformed);
    });
  });
});

/**
 * What the user sees when the build cannot run: a missing Stellar CLI, a
 * missing Rust toolchain or wasm target, and an ordinary compile failure. The
 * wording lives in src/diagnostics/setup.ts (setupErrors.test.ts asserts it);
 * these check that a real failed build reaches it, output tail included.
 */
describe('ContractBuilder failure diagnostics', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function contractDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-builder-fail-'));
    tempDirs.push(dir);
    return dir;
  }

  async function buildError(buildCommand: string): Promise<Error> {
    const dir = await contractDir();
    try {
      await new ContractBuilder().build({ contractDir: dir, buildCommand }, () => undefined);
    } catch (e) {
      const err = e as Error;
      assert.ok(isUserFacing(err), `expected a user-facing error, got ${err.name}: ${err.message}`);
      assert.ok(err.message.includes(TROUBLESHOOTING_URL), `expected the README link in: ${err.message}`);
      return err;
    }
    return assert.fail('expected the build to fail');
  }

  it('reports a missing `stellar` binary as a missing Stellar CLI', async () => {
    const err = await buildError('stellar-cli-does-not-exist-4f2a contract build');
    assert.match(err.message, /stellar-cli-does-not-exist-4f2a/);
    assert.match(err.message, /stellar\.cliPath|Stellar CLI/i);
  });

  it('reports a missing wasm target as a `rustup target add`', async () => {
    const err = await buildError(
      'printf "error[E0463]: can\'t find crate for \\`core\\`\\nnote: the \\`wasm32v1-none\\` target may not be installed\\n" >&2; exit 101',
    );
    assert.match(err.message, /rustup target add wasm32v1-none/);
  });

  it('reports an ordinary compile failure with its exit code and output tail', async () => {
    const err = await buildError('printf "error: could not compile \\`token\\`\\n" >&2; exit 101');
    assert.match(err.message, /code 101/);
    assert.match(err.message, /could not compile/);
  });

  it('reports a build that produced no wasm', async () => {
    const err = await buildError('true');
    assert.match(err.message, /wasm/);
    assert.match(err.message, /wasm32v1-none/);
  });
});
