/**
 * Thin CLI entry for the standalone TCP DAP server (`soroban-dap`).
 *
 * Parses `--host`/`--port` (default 4711) from argv, starts the server, and
 * logs the listening address to stderr. Coverage-excluded: the real logic lives
 * in `dapServer.ts`, exercised end-to-end by the integration test.
 */

import { startDapServer } from './dapServer';

/** Read the value following a flag, or undefined when absent. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const host = flag(argv, '--host');
  const portFlag = flag(argv, '--port');
  const port = portFlag !== undefined ? Number(portFlag) : 4711;

  const srv = await startDapServer({ host, port });
  process.stderr.write(
    `Soroban DAP server listening on ${host ?? '127.0.0.1'}:${srv.port}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n');
  process.exit(1);
});
