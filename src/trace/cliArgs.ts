/**
 * Pure argv parsing for the one-shot trace CLI (`soroban-trace`).
 *
 * Extracted from the coverage-excluded `main.ts` so the flag semantics can be
 * unit-tested directly. `parseTraceArgs` is the devex front door: it resolves
 * `--help`, validates tokens and mode selection, and maps argv onto a
 * discriminated union the (coverage-excluded) shell dispatches on. PURE: never
 * reads process.argv, never prints, never exits.
 */

import { SorobanLaunchArgs } from '../debugAdapter/types';
import { ScValArg } from '../soroban/scval';

/** The `soroban-trace` help text. */
export const TRACE_USAGE = `soroban-trace — emit a Rust source-level execution trace as JSONL

Usage:
  soroban-trace --raw-trace <file> [--wasm <file>] [options]     (offline replay)
  soroban-trace --contract <dir> --function <name> [options]     (build & run live)

Options:
  --raw-trace <file>    Recorded JSONL trace to replay (offline mode).
  --wasm <file>         Contract .wasm supplying DWARF debug info (source + variables).
  --contract <dir>      Crate directory to build and run (live mode).
  --function <name>     Contract function to invoke (required in live mode).
  --args-json <json>    Function arguments, e.g. '[{"value":1,"type":"u32"}]'.
  --out <file>          Write JSONL to a file instead of stdout.
  --depth <n>           Max variable-expansion depth (default 3).
  --max-children <n>    Max children materialized per aggregate (default 64).
  --allow-no-source     Don't error when the trace has no source-level stops.
  -h, --help            Show this help.

Examples:
  soroban-trace --raw-trace run.jsonl --wasm contract.wasm
  soroban-trace --contract . --function add --args-json '[{"value":1,"type":"u32"}]'
`;

/** Outcome of parsing `soroban-trace` argv. */
export type TraceParse =
  | { kind: 'help'; text: string }
  | { kind: 'error'; message: string }
  | {
      kind: 'run';
      launch: SorobanLaunchArgs;
      out?: string;
      opts: { maxDepth?: number; maxChildren?: number; allowNoSource?: boolean };
    };

const TRACE_HINT = "Run 'soroban-trace --help' for usage.";

/** Value-taking flags for `soroban-trace`. */
const TRACE_VALUE_FLAGS = new Set([
  '--raw-trace',
  '--wasm',
  '--contract',
  '--function',
  '--args-json',
  '--out',
  '--depth',
  '--max-children',
]);

/** Whether a token is being used as an option (leading dash). */
function looksLikeFlag(token: string): boolean {
  return token.startsWith('-');
}

/** Whether a string is a non-negative integer literal. */
function isNonNegInt(s: string): boolean {
  return /^\d+$/.test(s);
}

/**
 * Devex front door for `soroban-trace`: resolve `--help`, validate tokens and
 * mode selection, and map argv onto a `TraceParse`. Pure.
 */
export function parseTraceArgs(argv: string[]): TraceParse {
  // --help / -h wins anywhere.
  if (argv.includes('-h') || argv.includes('--help')) {
    return { kind: 'help', text: TRACE_USAGE };
  }

  const err = (message: string): TraceParse => ({
    kind: 'error',
    message: `${message} ${TRACE_HINT}`,
  });

  const values: Record<string, string> = {};
  let allowNoSource = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (TRACE_VALUE_FLAGS.has(token)) {
      const next = argv[i + 1];
      if (next === undefined || looksLikeFlag(next)) {
        return err(`Missing value for ${token}`);
      }
      values[token] = next;
      i++;
    } else if (token === '--allow-no-source') {
      allowNoSource = true;
    } else if (looksLikeFlag(token)) {
      return err(`Unknown option: ${token}`);
    } else {
      return err(`Unexpected argument: ${token}`);
    }
  }

  const rawTrace = values['--raw-trace'];
  const wasmPath = values['--wasm'];
  const contract = values['--contract'];
  const fn = values['--function'];
  const argsJson = values['--args-json'];
  const out = values['--out'];
  const depth = values['--depth'];
  const maxChildren = values['--max-children'];

  // Mode selection.
  if (rawTrace === undefined && contract === undefined && wasmPath === undefined) {
    return err(
      'Specify --raw-trace for offline replay, or --contract/--wasm with --function for live mode.',
    );
  }
  // Live mode (no --raw-trace) requires --function.
  if (rawTrace === undefined && fn === undefined) {
    return err('--function is required in live mode.');
  }

  // --args-json must JSON.parse to an array.
  let args: ScValArg[] | undefined;
  if (argsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson);
    } catch (e) {
      return err(`Invalid --args-json: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(parsed)) {
      return err('Invalid --args-json: expected a JSON array.');
    }
    args = parsed as ScValArg[];
  }

  // Numeric options must be non-negative integers.
  if (depth !== undefined && !isNonNegInt(depth)) {
    return err('--depth must be a non-negative integer.');
  }
  if (maxChildren !== undefined && !isNonNegInt(maxChildren)) {
    return err('--max-children must be a non-negative integer.');
  }

  const launch: SorobanLaunchArgs = {
    function: fn ?? '',
    rawTrace,
    wasmPath,
    contract,
    ...(args !== undefined ? { args } : {}),
  };

  const opts: { maxDepth?: number; maxChildren?: number; allowNoSource?: boolean } = {};
  if (depth !== undefined) opts.maxDepth = Number(depth);
  if (maxChildren !== undefined) opts.maxChildren = Number(maxChildren);
  if (allowNoSource) opts.allowNoSource = true;

  return { kind: 'run', launch, out, opts };
}
