/**
 * Thin CLI entry for the one-shot trace projection (`soroban-trace`).
 *
 * Parses argv, builds launch args, resolves a trace through the selected
 * backend, projects it to JSONL via `runCliTrace`, and writes the result to
 * `--out` (or stdout). Coverage-excluded: the real logic lives in
 * `runTrace.ts` / `projectStop.ts`, which are exercised directly by unit tests.
 */

import * as fs from 'fs';
import { backendFor } from '../debugAdapter/backendFor';
import { SorobanLaunchArgs } from '../debugAdapter/types';
import { ScValArg } from '../soroban/scval';
import { runCliTrace } from './runTrace';

/** Read the value following a flag, or undefined when absent. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Whether a boolean flag is present. */
function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const rawTrace = flag(argv, '--raw-trace');
  const wasmPath = flag(argv, '--wasm');
  const contract = flag(argv, '--contract');
  const fn = flag(argv, '--function');
  const argsJson = flag(argv, '--args-json');
  const out = flag(argv, '--out');
  const depth = flag(argv, '--depth');
  const maxChildrenFlag = flag(argv, '--max-children');
  const allowNoSource = has(argv, '--allow-no-source');

  const args: SorobanLaunchArgs = {
    function: fn ?? '',
    rawTrace,
    wasmPath,
    contract,
    args: argsJson ? (JSON.parse(argsJson) as ScValArg[]) : undefined,
  };

  const maxDepth = depth !== undefined ? Number(depth) : undefined;
  const maxChildren = maxChildrenFlag !== undefined ? Number(maxChildrenFlag) : undefined;

  const backend = backendFor(args);
  try {
    const resolved = await backend.resolve(args, (msg) => process.stderr.write(msg + '\n'));
    const lines = runCliTrace(resolved, {
      function: args.function,
      wasm: args.wasmPath,
      maxDepth,
      maxChildren,
      allowNoSource,
    });
    const output = lines.join('\n') + '\n';
    if (out) {
      fs.writeFileSync(out, output);
    } else {
      process.stdout.write(output);
    }
  } finally {
    await backend.dispose();
  }
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n');
  process.exit(1);
});
