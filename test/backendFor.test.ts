/**
 * Unit suite for the trace-acquisition backend selector (docs/trace-cli-internal.md,
 * "backendFor"). backendFor(args) picks the vscode-free backend from the launch
 * args, reused by the extension, the TCP server, and the CLI:
 *
 *   args.rawTrace present → RawTraceBackend (offline JSONL replay)
 *   otherwise             → LiveBackend (build → komet-node → trace pipeline)
 *
 * It reads only args.rawTrace, so it needs no vscode. The module does not exist
 * yet, so this is the red anchor for it.
 */

import * as assert from 'assert';
import { backendFor } from '../src/debugAdapter/backendFor';
import { RawTraceBackend } from '../src/debugAdapter/backends/RawTraceBackend';
import { LiveBackend } from '../src/debugAdapter/backends/LiveBackend';

describe('backendFor (docs/trace-cli-internal.md, backend selection)', () => {
  it('selects RawTraceBackend when rawTrace is present', () => {
    const backend = backendFor({ rawTrace: 'x.jsonl' } as any);
    assert.ok(
      backend instanceof RawTraceBackend,
      'expected a RawTraceBackend for a rawTrace launch',
    );
    assert.ok(
      !(backend instanceof LiveBackend),
      'a rawTrace launch must not select the LiveBackend',
    );
  });

  it('selects LiveBackend when there is no rawTrace', () => {
    const backend = backendFor({ function: 'add' } as any);
    assert.ok(
      backend instanceof LiveBackend,
      'expected a LiveBackend for a live (no rawTrace) launch',
    );
    assert.ok(
      !(backend instanceof RawTraceBackend),
      'a live launch must not select the RawTraceBackend',
    );
  });
});
