/**
 * Thin CLI entry for the standalone TCP DAP server (`soroban-dap`).
 *
 * Parses argv with the pure `parseServerArgs`, then — for a `run` result —
 * starts the server and logs the listening address to stderr. Help and usage
 * errors are the shared `runCli` shell's business. Coverage-excluded: the real
 * logic lives in `cliArgs.ts` / `dapServer.ts`, exercised directly by tests.
 */

import { runCli } from '../cli/shell';
import { parseServerArgs } from './cliArgs';
import { startDapServer } from './dapServer';

runCli(parseServerArgs(process.argv.slice(2)), async ({ host, port }) => {
  const server = await startDapServer({ host, port });
  process.stderr.write(`Soroban DAP server listening on ${host ?? '127.0.0.1'}:${server.port}\n`);
});
