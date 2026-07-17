/**
 * Trace-acquisition backend selector (docs/interfaces.md, "backendFor").
 *
 * Picks the vscode-free backend from the launch args: `args.rawTrace` present →
 * RawTraceBackend (offline JSONL replay), else LiveBackend (the full
 * build → komet-node → trace pipeline). Reads only `args.rawTrace`, so it needs
 * no `vscode`; reused by the extension, the TCP server, and the CLI.
 */

import { SessionBackend, SorobanLaunchArgs } from './types';
import { RawTraceBackend } from './backends/RawTraceBackend';
import { LiveBackend } from './backends/LiveBackend';

/** Selects a backend per launch configuration. */
export function backendFor(config: SorobanLaunchArgs): SessionBackend {
  if (config.rawTrace) {
    return new RawTraceBackend();
  }
  return new LiveBackend();
}
