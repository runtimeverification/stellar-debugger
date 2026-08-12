/**
 * Argv parsing for the standalone TCP DAP server CLI (`soroban-dap`).
 *
 * `parseServerArgs` resolves `--help`, validates `--host`/`--port`, and maps a
 * raw argv slice onto a discriminated union the (coverage-excluded) shell
 * dispatches on. PURE: never reads process.argv, never prints, never exits.
 */

import { CliParse } from '../cli/shell';
import { FlagSpec, isNonNegativeInt, parseFlags, wantsHelp } from '../cli/flags';

/** The `soroban-dap` help text. */
export const SERVER_USAGE = `soroban-dap — serve the Soroban debug adapter over a TCP socket

Usage:
  soroban-dap [--port <n>] [--host <addr>]

Options:
  --port <n>     TCP port to listen on (default 4711).
  --host <addr>  Interface to bind (default 127.0.0.1, loopback only).
  -h, --help     Show this help.

Connect any DAP client to the port (e.g. VS Code "debugServer": <port>).
`;

/** Outcome of parsing `soroban-dap` argv. */
export type ServerParse = CliParse<{ host?: string; port: number }>;

const HINT = "Run 'soroban-dap --help' for usage.";
const DEFAULT_PORT = 4711;
const MAX_PORT = 65535;

const FLAGS: FlagSpec = { value: ['--host', '--port'] };

/**
 * Devex front door for `soroban-dap`: resolve `--help`, validate tokens and
 * `--port`, and map argv onto a `ServerParse`. Pure.
 */
export function parseServerArgs(argv: string[]): ServerParse {
  if (wantsHelp(argv)) {
    return { kind: 'help', text: SERVER_USAGE };
  }
  const err = (message: string): ServerParse => ({ kind: 'error', message: `${message} ${HINT}` });

  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) {
    return err(parsed.message);
  }

  const host = parsed.values['--host'];
  const portRaw = parsed.values['--port'];
  if (portRaw === undefined) {
    return { kind: 'run', host, port: DEFAULT_PORT };
  }
  if (!isNonNegativeInt(portRaw) || Number(portRaw) > MAX_PORT) {
    return err(`--port must be an integer between 0 and ${MAX_PORT}.`);
  }
  return { kind: 'run', host, port: Number(portRaw) };
}
