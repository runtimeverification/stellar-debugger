/**
 * The process shell both CLI entry points (`stellar-trace`, `stellar-dap`) run
 * their parse result through, so they agree on the exit codes and on which
 * stream each kind of output goes to:
 *
 *   help   -> stdout, exit 0
 *   usage  -> stderr, exit 2
 *   run    -> the command; a thrown error goes to stderr, exit 1
 *
 * Coverage-excluded along with the entry points, being the same category of
 * process-level plumbing: the parsers it dispatches are unit-tested directly.
 */

/** A command's parse result: show help, report a usage error, or run with `R`. */
export type CliParse<R> =
  | { kind: 'help'; text: string }
  | { kind: 'error'; message: string }
  | (R & { kind: 'run' });

/** Dispatch a parse result (see the module header for the exit-code contract). */
export function runCli<R>(
  parsed: CliParse<R>,
  run: (args: R & { kind: 'run' }) => Promise<void>,
): void {
  if (parsed.kind === 'help') {
    process.stdout.write(parsed.text + '\n');
    return;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(parsed.message + '\n');
    process.exitCode = 2;
    return;
  }
  run(parsed).catch((err) => {
    process.stderr.write(String(err instanceof Error ? (err.stack ?? err.message) : err) + '\n');
    process.exit(1);
  });
}
