/**
 * Builds a Soroban contract crate to wasm and locates the produced artifact.
 *
 * Default build command is `stellar contract build`, which compiles to the
 * `wasm32v1-none` target on recent toolchains (older ones use
 * `wasm32-unknown-unknown`). We auto-detect both output directories.
 *
 * Pure module (uses child_process + fs, no `vscode` imports).
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ProgressReporter } from '../debugAdapter/types';
import { buildFailure, buildSpawnFailure, noWasmProduced } from '../diagnostics/setup';
import { parseWasmSections } from '../wasm/sections';

const TARGET_DIRS = ['wasm32v1-none', 'wasm32-unknown-unknown'];

export interface BuildOptions {
  /** Contract crate directory (containing Cargo.toml). */
  contractDir: string;
  /** Build command; defaults to `stellar contract build`. */
  buildCommand?: string;
  /**
   * Build with DWARF debug info (default true): injects
   * CARGO_PROFILE_RELEASE_DEBUG=true, CARGO_PROFILE_RELEASE_STRIP=none, and
   * CARGO_PROFILE_RELEASE_OPT_LEVEL=0 into the build environment (opt-level=0
   * is what preserves per-statement line info for source stepping; see
   * docs/stepping.md "Build prerequisite: optimization level") and warns after
   * the build if the located wasm lacks a `.debug_line` section.
   */
  debugInfo?: boolean;
}

/**
 * A build that could not produce a wasm. The message is written for the user by
 * `diagnostics/setup` — a missing Stellar CLI, a missing Rust toolchain or wasm
 * target, or the build's own output — so callers can surface it verbatim.
 */
export class ContractBuildError extends Error {
  readonly userFacing = true;

  constructor(message: string) {
    super(message);
    this.name = 'ContractBuildError';
  }
}

/** How many trailing output lines are kept to explain a failed build. */
const OUTPUT_TAIL_LINES = 40;

export class ContractBuilder {
  async build(opts: BuildOptions, report: ProgressReporter): Promise<string> {
    const debugInfo = opts.debugInfo !== false;
    const command = opts.buildCommand ?? 'stellar contract build';
    report(`Building contract: ${command} (in ${opts.contractDir})`);
    const env = debugInfo
      ? {
          ...process.env,
          CARGO_PROFILE_RELEASE_DEBUG: 'true',
          CARGO_PROFILE_RELEASE_STRIP: 'none',
          CARGO_PROFILE_RELEASE_OPT_LEVEL: '0',
        }
      : process.env;
    await this.run(command, opts.contractDir, env, report);

    const wasm = await this.findWasm(opts.contractDir, command);
    report(`Built wasm: ${wasm}`);
    if (debugInfo) {
      await this.warnIfMissingDebugLine(wasm, report);
    }
    return wasm;
  }

  /**
   * Run the build command, streaming its output to the console and keeping the
   * tail. A non-zero exit is classified into a user-facing diagnosis (missing
   * CLI, missing toolchain, missing wasm target, or a plain compile failure) by
   * `diagnostics/setup`, which is why the tail is collected at all: the exit
   * code alone cannot tell those apart.
   */
  private run(command: string, cwd: string, env: NodeJS.ProcessEnv, report: ProgressReporter): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, { cwd, env, shell: true });
      const output: string[] = [];
      const onOutput = (chunk: Buffer) => {
        const text = chunk.toString().trimEnd();
        report(text);
        output.push(text);
        if (output.length > OUTPUT_TAIL_LINES) {
          output.splice(0, output.length - OUTPUT_TAIL_LINES);
        }
      };
      child.stdout.on('data', onOutput);
      child.stderr.on('data', onOutput);
      child.on('error', (err) =>
        reject(new ContractBuildError(buildSpawnFailure({ command, error: err }).message)),
      );
      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new ContractBuildError(buildFailure({ command, cwd, code, signal, output }).message),
          );
        }
      });
    });
  }

  /**
   * Find the most recently modified release wasm under the known target dirs,
   * preferring `release/deps/` over `release/`: `stellar contract build`'s
   * metadata injection rewrites `release/<name>.wasm` and empties all DWARF
   * line programs, while the pristine wasm-ld output in `deps/` keeps them
   * (and the name section). Fall back to `release/*.wasm` only when `deps/`
   * has no wasm at all.
   */
  private async findWasm(contractDir: string, command: string): Promise<string> {
    const depsCandidates: { path: string; mtimeMs: number }[] = [];
    const releaseCandidates: { path: string; mtimeMs: number }[] = [];
    for (const target of TARGET_DIRS) {
      const releaseDir = path.join(contractDir, 'target', target, 'release');
      depsCandidates.push(...(await listWasm(path.join(releaseDir, 'deps'))));
      releaseCandidates.push(...(await listWasm(releaseDir)));
    }
    const candidates = depsCandidates.length > 0 ? depsCandidates : releaseCandidates;
    if (candidates.length === 0) {
      throw new ContractBuildError(noWasmProduced({ contractDir, command }).message);
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0].path;
  }

  /** Warn (never fail) when a freshly built wasm carries no `.debug_line` section. */
  private async warnIfMissingDebugLine(wasmPath: string, report: ProgressReporter): Promise<void> {
    let hasDebugLine: boolean;
    try {
      const bytes = await fs.readFile(wasmPath);
      hasDebugLine = parseWasmSections(bytes).customSection('.debug_line') !== undefined;
    } catch (err) {
      report(`Warning: could not inspect ${wasmPath} for debug info: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!hasDebugLine) {
      report(
        `Warning: ${wasmPath} has no .debug_line section — the build may have stripped debug info, ` +
          'so Rust source mapping will be unavailable (debugging continues at the wasm level).',
      );
    }
  }
}

async function listWasm(dir: string): Promise<{ path: string; mtimeMs: number }[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found: { path: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (name.endsWith('.wasm')) {
      const full = path.join(dir, name);
      const st = await fs.stat(full);
      found.push({ path: full, mtimeMs: st.mtimeMs });
    }
  }
  return found;
}
