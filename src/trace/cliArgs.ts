/**
 * Argv parsing for the one-shot trace CLI (`stellar-trace`).
 *
 * `parseTraceArgs` is the devex front door: it resolves `--help`, validates
 * tokens and mode selection, and maps argv onto a discriminated union the
 * (coverage-excluded) shell dispatches on. PURE: never reads process.argv, never
 * prints, never exits.
 */

import { SorobanLaunchArgs } from '../debugAdapter/types';
import { CliParse } from '../cli/shell';
import { FlagSpec, isNonNegativeInt, parseFlags, wantsHelp } from '../cli/flags';

/** The `stellar-trace` help text. */
export const TRACE_USAGE = `stellar-trace — emit a Rust source-level execution trace as JSONL

Usage:
  stellar-trace --raw-trace <file> [--wasm <file>] [options]     (offline replay)
  stellar-trace --contract <dir> --function <name> [options]     (build & run live)

Options:
  --raw-trace <file>    Recorded JSONL trace to replay (offline mode).
  --wasm <file>         Contract .wasm supplying DWARF debug info (source + variables).
  --contract <dir>      Crate directory to build and run (live mode).
  --function <name>     Contract function to invoke (required in live mode).
  --args-json <json>    Function arguments keyed by parameter name, e.g. '{"a":1,"b":2}'.
  --out <file>          Write JSONL to a file instead of stdout.
  --depth <n>           Max variable-expansion depth (default 3).
  --max-children <n>    Max children materialized per aggregate (default 64).
  --allow-no-source     Don't error when the trace has no source-level stops.
  --no-just-my-code     Include std/core and dependency source in the stops (default: only workspace code).
  -h, --help            Show this help.

Examples:
  stellar-trace --raw-trace run.jsonl --wasm contract.wasm
  stellar-trace --contract . --function add --args-json '{"a":1,"b":2}'
`;

/** The projection options `stellar-trace` passes through to `runCliTrace`. */
interface TraceOpts {
  maxDepth?: number;
  maxChildren?: number;
  allowNoSource?: boolean;
  justMyCode?: boolean;
}

/** Outcome of parsing `stellar-trace` argv. */
export type TraceParse = CliParse<{
  launch: SorobanLaunchArgs;
  /** Echoed for the trace's meta record: the invoked function (live mode). */
  function?: string;
  /** Echoed for the trace's meta record: the symbol-supplying wasm. */
  wasm?: string;
  out?: string;
  opts: TraceOpts;
}>;

const HINT = "Run 'stellar-trace --help' for usage.";

const FLAGS: FlagSpec = {
  value: [
    '--raw-trace',
    '--wasm',
    '--contract',
    '--function',
    '--args-json',
    '--out',
    '--depth',
    '--max-children',
  ],
  switches: ['--allow-no-source', '--no-just-my-code'],
};

/**
 * Devex front door for `stellar-trace`: resolve `--help`, validate tokens and
 * mode selection, and map argv onto a `TraceParse`. Pure.
 */
export function parseTraceArgs(argv: string[]): TraceParse {
  if (wantsHelp(argv)) {
    return { kind: 'help', text: TRACE_USAGE };
  }
  const err = (message: string): TraceParse => ({ kind: 'error', message: `${message} ${HINT}` });

  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) {
    return err(parsed.message);
  }
  const { values, switches } = parsed;
  const rawTrace = values['--raw-trace'];
  const wasmPath = values['--wasm'];
  const contract = values['--contract'];
  const fn = values['--function'];
  const out = values['--out'];
  const depth = values['--depth'];
  const maxChildren = values['--max-children'];

  // Mode selection: replay needs a trace, live needs something to run.
  if (rawTrace === undefined && contract === undefined && wasmPath === undefined) {
    return err(
      'Specify --raw-trace for offline replay, or --contract/--wasm with --function for live mode.',
    );
  }
  if (rawTrace === undefined && fn === undefined) {
    return err('--function is required in live mode.');
  }

  const args = parseArgsJson(values['--args-json']);
  if (typeof args === 'string') {
    return err(args);
  }

  if (depth !== undefined && !isNonNegativeInt(depth)) {
    return err('--depth must be a non-negative integer.');
  }
  if (maxChildren !== undefined && !isNonNegativeInt(maxChildren)) {
    return err('--max-children must be a non-negative integer.');
  }

  const opts: TraceOpts = {};
  if (depth !== undefined) opts.maxDepth = Number(depth);
  if (maxChildren !== undefined) opts.maxChildren = Number(maxChildren);
  if (switches.has('--allow-no-source')) opts.allowNoSource = true;
  // Only set when explicitly disabled; absence means "default true" downstream (S21).
  if (switches.has('--no-just-my-code')) opts.justMyCode = false;

  return {
    kind: 'run',
    launch:
      rawTrace !== undefined
        ? replayLaunch(rawTrace, wasmPath)
        : liveLaunch(contract, wasmPath, fn!, args),
    function: fn,
    wasm: wasmPath,
    out,
    opts,
  };
}

/** REPLAY mode: a top-level `rawTrace` plus the optional replay-symbol wasm. */
function replayLaunch(rawTrace: string, wasmPath: string | undefined): SorobanLaunchArgs {
  return { rawTrace, ...(wasmPath !== undefined ? { wasmPath } : {}) };
}

/**
 * LIVE mode: the CLI is a single-invoke front end for the one `transactions`
 * schema, desugaring to a deploy of the `--contract`/`--wasm` source under a
 * fixed handle followed by an invoke of `--function`.
 */
function liveLaunch(
  contract: string | undefined,
  wasmPath: string | undefined,
  fn: string,
  args: Record<string, unknown> | undefined,
): SorobanLaunchArgs {
  return {
    transactions: [
      {
        kind: 'deploy',
        id: 'contract',
        ...(wasmPath !== undefined ? { wasm: wasmPath } : {}),
        ...(contract !== undefined ? { contract } : {}),
      },
      {
        kind: 'invoke',
        contract: 'contract',
        function: fn,
        ...(args !== undefined ? { args } : {}),
      },
    ],
  };
}

/**
 * `--args-json` must parse to an object keyed by the function's parameter names;
 * the contract's own spec encodes the values (see soroban/specEncode). Returns
 * the parsed object, `undefined` when the flag is absent, or an error message.
 */
function parseArgsJson(json: string | undefined): Record<string, unknown> | undefined | string {
  if (json === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return `Invalid --args-json: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'Invalid --args-json: expected a JSON object keyed by parameter name.';
  }
  return parsed as Record<string, unknown>;
}
