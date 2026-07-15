/**
 * Shared types for the debug adapter: the launch-configuration shape and the
 * backend abstraction that produces a replayable trace.
 *
 * Pure module (no `vscode` / DAP imports).
 */

import { DebugProtocol } from '@vscode/debugprotocol';
import { TraceModel } from './TraceModel';
import { SourceMapper } from '../sourcemap/SourceMapper';
import { VariableResolver } from '../sourcemap/VariableResolver';
import { Disassembly } from '../wasm/Disassembly';
import { ScValArg } from '../soroban/scval';

/** Attributes of a `soroban` launch configuration (mirrors package.json). */
export interface SorobanLaunchArgs extends DebugProtocol.LaunchRequestArguments {
  /** Path to the contract crate (containing Cargo.toml). */
  contract?: string;
  /**
   * Path to a prebuilt .wasm (overrides building from `contract`). Also used
   * with `rawTrace` for offline symbol-rich replay: the wasm supplies the
   * disassembly and DWARF source mapping for a canned trace.
   */
  wasmPath?: string;
  /** Build command used to produce the wasm. */
  buildCommand?: string;
  /**
   * Build the contract with DWARF debug info (default true): injects the
   * cargo profile overrides that keep line tables in the wasm, enabling Rust
   * source mapping. Set false to build untouched and debug at the wasm level.
   */
  debugInfo?: boolean;
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
  /** Resolves and decodes source-level variables at a PC (Null when no DWARF). */
  variables: VariableResolver;
  /** Static disassembly of the traced contract (trace-derived when no wasm). */
  disassembly: Disassembly;
  /**
   * Per-record code offset, parallel to `model.records`: the record's VALIDATED
   * position in `disassembly`'s address space, or null for records without one
   * (synthetic records, and records whose `pos` failed mnemonic validation,
   * e.g. global initializers). Anchors the client's instruction pointer.
   */
  positions: (number | null)[];
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
