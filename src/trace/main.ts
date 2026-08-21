/**
 * Thin CLI entry for the one-shot trace projection (`stellar-trace`).
 *
 * Parses argv with the pure `parseTraceArgs`, then — for a `run` result —
 * resolves a trace through the selected backend, projects it to JSONL via
 * `runCliTrace`, and writes it to `--out` (or stdout). Help and usage errors are
 * the shared `runCli` shell's business. Coverage-excluded: the real logic lives
 * in `cliArgs.ts` / `runTrace.ts` / `projectStop.ts`, exercised directly by tests.
 */

import * as fs from 'fs';
import { backendFor } from '../debugAdapter/backendFor';
import { runCli } from '../cli/shell';
import { parseTraceArgs } from './cliArgs';
import { runCliTrace } from './runTrace';

runCli(parseTraceArgs(process.argv.slice(2)), async ({ launch, out, opts, ...meta }) => {
  const backend = backendFor(launch);
  try {
    const resolved = await backend.resolve(launch, (msg) => process.stderr.write(msg + '\n'));
    const output = runCliTrace(resolved, { function: meta.function, wasm: meta.wasm, ...opts }).join('\n') + '\n';
    if (out) {
      fs.writeFileSync(out, output);
    } else {
      process.stdout.write(output);
    }
  } finally {
    await backend.dispose();
  }
});
