/**
 * Standalone adapter runner for tests: starts a SorobanDebugSession backed by
 * the RawTraceBackend over stdin/stdout, so @vscode/debugadapter-testsupport's
 * DebugClient can drive the real DAP handlers as a child process.
 */

import { SorobanDebugSession } from '../../src/debugAdapter/SorobanDebugSession';
import { RawTraceBackend } from '../../src/debugAdapter/backends/RawTraceBackend';

const session = new SorobanDebugSession(new RawTraceBackend());
process.on('SIGTERM', () => session.shutdown());
session.start(process.stdin, process.stdout);
