/**
 * Shared types for the debug adapter: the launch-configuration shape and the
 * backend abstraction that produces a replayable trace.
 *
 * Pure module (no `vscode` / DAP imports).
 */

import { DebugProtocol } from '@vscode/debugprotocol';
import { TraceModel } from './TraceModel';
import { SourceMapper } from '../sourcemap/SourceMapper';
import { ScValArg } from '../soroban/scval';

/** Attributes of a `soroban` launch configuration (mirrors package.json). */
export interface SorobanLaunchArgs extends DebugProtocol.LaunchRequestArguments {
  /** Path to the contract crate (containing Cargo.toml). */
  contract?: string;
  /** Path to a prebuilt .wasm (overrides building from `contract`). */
  wasmPath?: string;
  /** Build command used to produce the wasm. */
  buildCommand?: string;
  /** Function to invoke. */
  function: string;
  /** Declarative function arguments. */
  args?: ScValArg[];
  /** komet-node connection / spawn settings. */
  node?: {
    attach?: boolean;
    host?: string;
    port?: number;
    command?: string;
    /** Directory komet-node uses for its I/O artifacts (`--io-dir`). */
    ioDir?: string;
  };
  /** Optional source account secret; a fresh account is seeded if omitted. */
  sourceSecret?: string;
  /** Attach mode: replay a precomputed JSONL trace file (skips all RPC). */
  rawTrace?: string;
}

/** Progress reporter so backends can stream status into the debug console. */
export type ProgressReporter = (message: string) => void;

/** The product of resolving a launch: a replayable trace + how to display it. */
export interface ResolvedTrace {
  model: TraceModel;
  source: SourceMapper;
  /** Optional human-readable invocation return value, for the debug console. */
  returnValue?: string;
}

/**
 * A SessionBackend turns launch arguments into a replayable trace. Different
 * backends implement different acquisition strategies (replay a file, attach to
 * a running node, or the full turnkey build+deploy+trace pipeline) behind one
 * interface, keeping the DAP session itself a pure replay machine.
 */
export interface SessionBackend {
  resolve(args: SorobanLaunchArgs, report: ProgressReporter): Promise<ResolvedTrace>;
  dispose(): Promise<void>;
}
