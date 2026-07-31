/**
 * Unit suite for the pure argv parser behind the one-shot trace CLI
 * (`soroban-trace`), milestone M3 (CLI devex: --help + argument validation).
 *
 *   parseTraceArgs(argv): TraceParse   from src/trace/cliArgs.ts
 *   TRACE_USAGE: string                the help text
 *
 * The parser is PURE — it never touches process.argv, never prints, never
 * exits. It maps a raw argv slice onto a discriminated union describing what
 * the (coverage-excluded) main.ts shell should do: show help, report a usage
 * error, or run with a resolved launch + projection options.
 *
 * These modules do not export this API yet, so this is the red anchor for it.
 */

import * as assert from 'assert';
import { parseTraceArgs, TRACE_USAGE, TraceParse } from '../src/trace/cliArgs';

/** Narrow a TraceParse to the 'run' variant (fails the test otherwise). */
function asRun(p: TraceParse): Extract<TraceParse, { kind: 'run' }> {
  assert.strictEqual(p.kind, 'run', `expected run, got ${p.kind}: ${JSON.stringify(p)}`);
  return p as Extract<TraceParse, { kind: 'run' }>;
}

/** Narrow a TraceParse to the 'error' variant and return its message. */
function asError(p: TraceParse): string {
  assert.strictEqual(p.kind, 'error', `expected error, got ${p.kind}: ${JSON.stringify(p)}`);
  return (p as Extract<TraceParse, { kind: 'error' }>).message;
}

/** Narrow a TraceParse to the 'help' variant and return its text. */
function asHelp(p: TraceParse): string {
  assert.strictEqual(p.kind, 'help', `expected help, got ${p.kind}: ${JSON.stringify(p)}`);
  return (p as Extract<TraceParse, { kind: 'help' }>).text;
}

describe('parseTraceArgs (M3 CLI devex)', () => {
  describe('help', () => {
    it('--help → kind "help" with the usage text', () => {
      const text = asHelp(parseTraceArgs(['--help']));
      assert.strictEqual(text, TRACE_USAGE);
    });

    it('-h → kind "help" with the usage text', () => {
      const text = asHelp(parseTraceArgs(['-h']));
      assert.strictEqual(text, TRACE_USAGE);
    });

    it('--help wins even alongside otherwise-valid flags', () => {
      const text = asHelp(parseTraceArgs(['--raw-trace', 'run.jsonl', '--help']));
      assert.strictEqual(text, TRACE_USAGE);
    });

    it('TRACE_USAGE carries the documented stable substrings', () => {
      for (const needle of [
        'soroban-trace',
        'Usage',
        '--raw-trace',
        '--wasm',
        '--contract',
        '--function',
        '--allow-no-source',
        '--no-just-my-code',
        '-h, --help',
        'Examples',
      ]) {
        assert.ok(TRACE_USAGE.includes(needle), `TRACE_USAGE should contain ${needle}`);
      }
    });
  });

  describe('mode selection', () => {
    it('[] → error, must specify a mode', () => {
      const msg = asError(parseTraceArgs([]));
      assert.ok(msg.includes('Specify --raw-trace'), msg);
    });

    it('error messages carry the --help hint', () => {
      const msg = asError(parseTraceArgs([]));
      assert.ok(msg.includes('--help'), `error should hint at --help: ${msg}`);
    });

    it('--contract without --function → error, function required in live mode', () => {
      const msg = asError(parseTraceArgs(['--contract', '.']));
      assert.ok(msg.includes('--function is required'), msg);
    });
  });

  describe('offline mode (--raw-trace)', () => {
    it('--raw-trace with no value → "Missing value for --raw-trace"', () => {
      const msg = asError(parseTraceArgs(['--raw-trace']));
      assert.ok(msg.includes('Missing value for --raw-trace'), msg);
    });

    it('--raw-trace <file> → run with launch.rawTrace set', () => {
      const p = asRun(parseTraceArgs(['--raw-trace', 'run.jsonl']));
      assert.strictEqual(p.launch.rawTrace, 'run.jsonl');
    });

    it('--raw-trace <file> --wasm <file> → run with launch.wasmPath set', () => {
      const p = asRun(parseTraceArgs(['--raw-trace', 'r', '--wasm', 'w']));
      assert.strictEqual(p.launch.rawTrace, 'r');
      assert.strictEqual(p.launch.wasmPath, 'w');
    });
  });

  describe('live mode (--contract/--wasm + --function)', () => {
    it('--contract . --function add → run with a deploy+invoke transactions config', () => {
      const p = asRun(parseTraceArgs(['--contract', '.', '--function', 'add']));

      // Live mode now builds the single `transactions` schema: a deploy of the
      // --contract dir under the fixed handle id 'contract', then an invoke of
      // --function against that handle. (Cast through the not-yet-updated
      // TraceLaunch type, which the implementer will reshape.)
      const launch = p.launch as unknown as { transactions?: unknown[] };
      const steps = launch.transactions!;
      assert.strictEqual(steps.length, 2);

      const deploy = steps[0] as { kind: string; id: string; contract?: string };
      assert.strictEqual(deploy.kind, 'deploy');
      assert.strictEqual(deploy.id, 'contract');
      assert.strictEqual(deploy.contract, '.');

      const invoke = steps[1] as { kind: string; contract: string; function: string };
      assert.strictEqual(invoke.kind, 'invoke');
      assert.strictEqual(invoke.contract, 'contract');
      assert.strictEqual(invoke.function, 'add');

      // The run result echoes the function name for the trace's meta record.
      assert.strictEqual((p as unknown as { function?: string }).function, 'add');
    });
  });

  describe('--args-json', () => {
    it('malformed JSON → error containing "Invalid --args-json"', () => {
      const msg = asError(
        parseTraceArgs(['--contract', '.', '--function', 'a', '--args-json', '[bad']),
      );
      assert.ok(msg.includes('Invalid --args-json'), msg);
    });

    it('valid JSON array → run with the invoke step carrying the parsed args', () => {
      const p = asRun(
        parseTraceArgs([
          '--contract',
          '.',
          '--function',
          'a',
          '--args-json',
          '[{"value":1,"type":"u32"}]',
        ]),
      );
      const launch = p.launch as unknown as { transactions?: unknown[] };
      const invoke = launch.transactions![1] as { args?: unknown[] };
      assert.ok(invoke.args, 'the invoke step should carry args');
      assert.strictEqual(invoke.args!.length, 1);
    });

    it('valid JSON that is not an array (number) → "expected a JSON array"', () => {
      const msg = asError(
        parseTraceArgs(['--contract', '.', '--function', 'a', '--args-json', '5']),
      );
      assert.ok(msg.includes('expected a JSON array'), msg);
    });

    it('valid JSON that is not an array (object) → "expected a JSON array"', () => {
      const msg = asError(
        parseTraceArgs(['--contract', '.', '--function', 'a', '--args-json', '{}']),
      );
      assert.ok(msg.includes('expected a JSON array'), msg);
    });
  });

  describe('numeric options', () => {
    it('--depth x (non-integer) → error mentioning --depth', () => {
      const msg = asError(parseTraceArgs(['--raw-trace', 'r', '--depth', 'x']));
      assert.ok(msg.includes('--depth'), msg);
    });

    it('--max-children -1 (leading dash) → missing-value branch, "Missing value for --max-children"', () => {
      // `-1` looks like a flag, so it trips the missing-value guard before the
      // numeric check ever runs.
      const msg = asError(parseTraceArgs(['--raw-trace', 'r', '--max-children', '-1']));
      assert.ok(msg.includes('Missing value for --max-children'), msg);
    });

    it('--max-children 2.5 (non-integer value) → "must be a non-negative integer"', () => {
      // A non-dash, non-numeric value reaches isNonNegInt and fails there.
      const msg = asError(parseTraceArgs(['--raw-trace', 'r', '--max-children', '2.5']));
      assert.ok(msg.includes('--max-children'), msg);
      assert.ok(msg.includes('non-negative integer'), msg);
    });

    it('--depth 2 → run with opts.maxDepth === 2', () => {
      const p = asRun(parseTraceArgs(['--raw-trace', 'r', '--depth', '2']));
      assert.strictEqual(p.opts.maxDepth, 2);
    });

    it('--depth 0 (boundary) → valid run with opts.maxDepth === 0', () => {
      const p = asRun(parseTraceArgs(['--raw-trace', 'r', '--depth', '0']));
      assert.strictEqual(p.opts.maxDepth, 0);
    });
  });

  describe('token validation', () => {
    it('unknown flag → "Unknown option: --frobnicate"', () => {
      const msg = asError(parseTraceArgs(['--frobnicate']));
      assert.ok(msg.includes('Unknown option: --frobnicate'), msg);
    });

    it('stray positional → "Unexpected argument: stray"', () => {
      const msg = asError(parseTraceArgs(['--raw-trace', 'r', 'stray']));
      assert.ok(msg.includes('Unexpected argument: stray'), msg);
    });
  });

  describe('boolean & passthrough options', () => {
    it('--allow-no-source → run with opts.allowNoSource === true', () => {
      const p = asRun(parseTraceArgs(['--raw-trace', 'r', '--allow-no-source']));
      assert.strictEqual(p.opts.allowNoSource, true);
    });

    it('--no-just-my-code → run with opts.justMyCode === false (S21)', () => {
      const p = asRun(parseTraceArgs(['--raw-trace', 'r', '--no-just-my-code']));
      assert.strictEqual(p.opts.justMyCode, false);
    });

    it('without the flag, opts.justMyCode is undefined (defaults to true downstream)', () => {
      const p = asRun(parseTraceArgs(['--raw-trace', 'r']));
      assert.strictEqual(p.opts.justMyCode, undefined);
    });

    it('--out o.jsonl → run with out === "o.jsonl"', () => {
      const p = asRun(parseTraceArgs(['--raw-trace', 'r', '--out', 'o.jsonl']));
      assert.strictEqual(p.out, 'o.jsonl');
    });
  });
});
