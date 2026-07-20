/**
 * Pure argv parsing for the standalone TCP DAP server CLI (`soroban-dap`).
 *
 * `parseServerArgs` resolves `--help`, validates `--host`/`--port`, and maps a
 * raw argv slice onto a discriminated union the (coverage-excluded) shell
 * dispatches on. PURE: never reads process.argv, never prints, never exits.
 */

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
export type ServerParse =
  | { kind: 'help'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'run'; host?: string; port: number };

const SERVER_HINT = "Run 'soroban-dap --help' for usage.";

/** Value-taking flags for `soroban-dap`. */
const SERVER_VALUE_FLAGS = new Set(['--host', '--port']);

/** Whether a token is being used as an option (leading dash). */
function looksLikeFlag(token: string): boolean {
  return token.startsWith('-');
}

/**
 * Devex front door for `soroban-dap`: resolve `--help`, validate tokens and
 * `--port`, and map argv onto a `ServerParse`. Pure.
 */
export function parseServerArgs(argv: string[]): ServerParse {
  // --help / -h wins anywhere.
  if (argv.includes('-h') || argv.includes('--help')) {
    return { kind: 'help', text: SERVER_USAGE };
  }

  const err = (message: string): ServerParse => ({
    kind: 'error',
    message: `${message} ${SERVER_HINT}`,
  });

  const values: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (SERVER_VALUE_FLAGS.has(token)) {
      const next = argv[i + 1];
      if (next === undefined || looksLikeFlag(next)) {
        return err(`Missing value for ${token}`);
      }
      values[token] = next;
      i++;
    } else if (looksLikeFlag(token)) {
      return err(`Unknown option: ${token}`);
    } else {
      return err(`Unexpected argument: ${token}`);
    }
  }

  const host = values['--host'];
  const portRaw = values['--port'];

  let port = 4711;
  if (portRaw !== undefined) {
    if (!/^\d+$/.test(portRaw)) {
      return err('--port must be an integer between 0 and 65535.');
    }
    port = Number(portRaw);
    if (port > 65535) {
      return err('--port must be an integer between 0 and 65535.');
    }
  }

  return { kind: 'run', host, port };
}
