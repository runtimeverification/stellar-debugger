/**
 * Standalone TCP DAP server (`soroban-dap`) — docs/interfaces.md, "Interface 2".
 *
 * Opens a `net.createServer`; for each connection it creates a fresh
 * `SorobanDebugSession(backendFor)` (the selector overload, so the backend can
 * depend on the per-connection launch config) and pipes `session.start(socket,
 * socket)`. On socket close/error it calls `session.teardown()` so
 * `backend.dispose()` runs and a `LiveBackend` komet-node process is not leaked
 * even on an ABRUPT disconnect that sends no `disconnect` request over the wire
 * (editor crash, network drop, SIGKILL). `DebugSession.shutdown()` can NOT be
 * used for this: it is a no-op in server mode, so it would never dispose the
 * backend — hence the explicit idempotent `teardown()`, which also runs on a
 * clean `disconnect` and guards against double-dispose. This is DAP's canonical
 * "server mode": any DAP client can connect to the port. No `vscode` import.
 */

import * as net from 'net';
import { SorobanDebugSession } from '../debugAdapter/SorobanDebugSession';
import { backendFor } from '../debugAdapter/backendFor';
import { SessionBackend, SorobanLaunchArgs } from '../debugAdapter/types';

export interface DapServerOptions {
  host?: string;
  port: number;
  /**
   * Backend selector; defaults to the real `backendFor`. Injectable so tests
   * can observe per-connection teardown with a spy backend.
   */
  backendFor?: (args: SorobanLaunchArgs) => SessionBackend;
}

export async function startDapServer(
  opts: DapServerOptions,
): Promise<{ port: number; close: () => Promise<void> }> {
  const select = opts.backendFor ?? backendFor;
  const server = net.createServer((socket) => {
    const session = new SorobanDebugSession(select);
    // Server mode: a dropped connection must tear down only this session, never
    // the shared server process. Without this, DebugSession.shutdown() calls
    // process.exit(0) 100ms after any socket closes (docs/interfaces.md,
    // "DAP's canonical server mode").
    session.setRunAsServer(true);
    session.start(socket, socket);
    // Dispose the per-connection backend on teardown. shutdown() is a no-op in
    // server mode, so it can't do this; teardown() is idempotent, so a clean
    // `disconnect` (which already disposed) makes this a harmless no-op.
    const teardown = () => {
      void session.teardown();
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
  });

  await new Promise<void>((resolve) => {
    server.listen(opts.port, opts.host ?? '127.0.0.1', resolve);
  });

  const port = (server.address() as net.AddressInfo).port;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return { port, close };
}
