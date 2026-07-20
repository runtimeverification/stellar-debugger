/**
 * Thin CLI entry for the standalone TCP DAP server (`soroban-dap`).
 *
 * Parses argv (via `parseServerArgs`), then dispatches: show help (stdout, exit
 * 0), report a usage error (stderr, exit 2), or start the server and log the
 * listening address to stderr. Coverage-excluded: the real logic lives in
 * `cliArgs.ts` / `dapServer.ts`, exercised directly by tests.
 */

import { parseServerArgs } from './cliArgs';
import { startDapServer } from './dapServer';

async function main(): Promise<void> {
  const p = parseServerArgs(process.argv.slice(2));

  if (p.kind === 'help') {
    process.stdout.write(p.text + '\n');
    return;
  }
  if (p.kind === 'error') {
    process.stderr.write(p.message + '\n');
    process.exitCode = 2;
    return;
  }

  const srv = await startDapServer({ host: p.host, port: p.port });
  process.stderr.write(
    `Soroban DAP server listening on ${p.host ?? '127.0.0.1'}:${srv.port}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n');
  process.exit(1);
});
