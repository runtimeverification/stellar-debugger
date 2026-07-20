/**
 * Unit suite for the pure argv parser behind the DAP TCP server CLI
 * (`soroban-dap`), milestone M3 (CLI devex: --help + argument validation).
 *
 *   parseServerArgs(argv): ServerParse   from src/server/cliArgs.ts
 *   SERVER_USAGE: string                 the help text
 *
 * The parser is PURE — it never touches process.argv, never prints, never
 * exits. It maps a raw argv slice onto a discriminated union describing what
 * the (coverage-excluded) main.ts shell should do: show help, report a usage
 * error, or run with a host/port.
 *
 * This module does not exist yet, so this is the red anchor for it.
 */

import * as assert from 'assert';
import { parseServerArgs, SERVER_USAGE, ServerParse } from '../src/server/cliArgs';

/** Narrow a ServerParse to the 'run' variant (fails the test otherwise). */
function asRun(p: ServerParse): Extract<ServerParse, { kind: 'run' }> {
  assert.strictEqual(p.kind, 'run', `expected run, got ${p.kind}: ${JSON.stringify(p)}`);
  return p as Extract<ServerParse, { kind: 'run' }>;
}

/** Narrow a ServerParse to the 'error' variant and return its message. */
function asError(p: ServerParse): string {
  assert.strictEqual(p.kind, 'error', `expected error, got ${p.kind}: ${JSON.stringify(p)}`);
  return (p as Extract<ServerParse, { kind: 'error' }>).message;
}

/** Narrow a ServerParse to the 'help' variant and return its text. */
function asHelp(p: ServerParse): string {
  assert.strictEqual(p.kind, 'help', `expected help, got ${p.kind}: ${JSON.stringify(p)}`);
  return (p as Extract<ServerParse, { kind: 'help' }>).text;
}

describe('parseServerArgs (M3 CLI devex)', () => {
  describe('help', () => {
    it('--help → kind "help" with the usage text', () => {
      const text = asHelp(parseServerArgs(['--help']));
      assert.strictEqual(text, SERVER_USAGE);
    });

    it('-h → kind "help" with the usage text', () => {
      const text = asHelp(parseServerArgs(['-h']));
      assert.strictEqual(text, SERVER_USAGE);
    });

    it('--help wins even alongside otherwise-valid flags', () => {
      const text = asHelp(parseServerArgs(['--port', '5000', '--help']));
      assert.strictEqual(text, SERVER_USAGE);
    });

    it('SERVER_USAGE carries the documented stable substrings', () => {
      for (const needle of ['soroban-dap', 'Usage', '--port', '--host', '-h, --help']) {
        assert.ok(SERVER_USAGE.includes(needle), `SERVER_USAGE should contain ${needle}`);
      }
    });
  });

  describe('defaults', () => {
    it('[] → run with port 4711 and host undefined', () => {
      const p = asRun(parseServerArgs([]));
      assert.strictEqual(p.port, 4711);
      assert.strictEqual(p.host, undefined);
    });
  });

  describe('--port', () => {
    it('--port 5000 → run with port 5000', () => {
      const p = asRun(parseServerArgs(['--port', '5000']));
      assert.strictEqual(p.port, 5000);
    });

    it('--port 0 → run with port 0 (valid boundary)', () => {
      const p = asRun(parseServerArgs(['--port', '0']));
      assert.strictEqual(p.port, 0);
    });

    it('--port 65535 → run with port 65535 (valid upper boundary)', () => {
      const p = asRun(parseServerArgs(['--port', '65535']));
      assert.strictEqual(p.port, 65535);
    });

    it('--port abc (non-integer) → error mentioning --port', () => {
      const msg = asError(parseServerArgs(['--port', 'abc']));
      assert.ok(msg.includes('--port'), msg);
    });

    it('--port 65536 (off-by-one, out of range) → error "between 0 and 65535"', () => {
      const msg = asError(parseServerArgs(['--port', '65536']));
      assert.ok(msg.includes('between 0 and 65535'), msg);
    });

    it('--port 70000 (out of range) → error "between 0 and 65535"', () => {
      const msg = asError(parseServerArgs(['--port', '70000']));
      assert.ok(msg.includes('between 0 and 65535'), msg);
    });

    it('--port with no value → "Missing value for --port"', () => {
      const msg = asError(parseServerArgs(['--port']));
      assert.ok(msg.includes('Missing value for --port'), msg);
    });

    it('--host --port (value is a flag) → "Missing value for --host"', () => {
      const msg = asError(parseServerArgs(['--host', '--port']));
      assert.ok(msg.includes('Missing value for --host'), msg);
    });
  });

  describe('--host', () => {
    it('--host 0.0.0.0 --port 9229 → run with both set', () => {
      const p = asRun(parseServerArgs(['--host', '0.0.0.0', '--port', '9229']));
      assert.strictEqual(p.host, '0.0.0.0');
      assert.strictEqual(p.port, 9229);
    });
  });

  describe('token validation', () => {
    it('unknown flag → "Unknown option: --nope"', () => {
      const msg = asError(parseServerArgs(['--nope']));
      assert.ok(msg.includes('Unknown option: --nope'), msg);
    });

    it('stray positional → "Unexpected argument: stray"', () => {
      const msg = asError(parseServerArgs(['stray']));
      assert.ok(msg.includes('Unexpected argument: stray'), msg);
    });
  });
});
