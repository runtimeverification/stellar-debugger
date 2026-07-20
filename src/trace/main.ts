/**
 * Thin CLI entry for the one-shot trace projection (`soroban-trace`).
 *
 * Parses argv (via `parseTraceArgs`), then dispatches: show help (stdout, exit
 * 0), report a usage error (stderr, exit 2), or resolve a trace through the
 * selected backend, project it to JSONL via `runCliTrace`, and write the result
 * to `--out` (or stdout). Coverage-excluded: the real logic lives in
 * `cliArgs.ts` / `runTrace.ts` / `projectStop.ts`, exercised directly by tests.
 */

import * as fs from 'fs';
import { backendFor } from '../debugAdapter/backendFor';
import { parseTraceArgs } from './cliArgs';
import { runCliTrace } from './runTrace';

async function main(): Promise<void> {
  const p = parseTraceArgs(process.argv.slice(2));

  if (p.kind === 'help') {
    process.stdout.write(p.text + '\n');
    return;
  }
  if (p.kind === 'error') {
    process.stderr.write(p.message + '\n');
    process.exitCode = 2;
    return;
  }

  const { launch, out, opts } = p;
  const backend = backendFor(launch);
  try {
    const resolved = await backend.resolve(launch, (msg) => process.stderr.write(msg + '\n'));
    const lines = runCliTrace(resolved, {
      function: launch.function,
      wasm: launch.wasmPath,
      ...opts,
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
