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

const TARGET_DIRS = ['wasm32v1-none', 'wasm32-unknown-unknown'];

export interface BuildOptions {
  /** Contract crate directory (containing Cargo.toml). */
  contractDir: string;
  /** Build command; defaults to `stellar contract build`. */
  buildCommand?: string;
  /** Explicit wasm path; if set, skips building and just returns it. */
  wasmPath?: string;
}

export class ContractBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractBuildError';
  }
}

export class ContractBuilder {
  async build(opts: BuildOptions, report: ProgressReporter): Promise<string> {
    if (opts.wasmPath) {
      await assertFile(opts.wasmPath, 'wasmPath');
      report(`Using prebuilt wasm: ${opts.wasmPath}`);
      return opts.wasmPath;
    }

    const command = opts.buildCommand ?? 'stellar contract build';
    report(`Building contract: ${command} (in ${opts.contractDir})`);
    await this.run(command, opts.contractDir, report);

    const wasm = await this.findWasm(opts.contractDir);
    report(`Built wasm: ${wasm}`);
    return wasm;
  }

  private run(command: string, cwd: string, report: ProgressReporter): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, { cwd, shell: true });
      child.stdout.on('data', (d) => report(d.toString().trimEnd()));
      child.stderr.on('data', (d) => report(d.toString().trimEnd()));
      child.on('error', (err) => reject(new ContractBuildError(`failed to run '${command}': ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new ContractBuildError(`build command exited with code ${code}`));
        }
      });
    });
  }

  /** Find the most recently modified release wasm under the known target dirs. */
  private async findWasm(contractDir: string): Promise<string> {
    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const target of TARGET_DIRS) {
      const dir = path.join(contractDir, 'target', target, 'release');
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.endsWith('.wasm')) {
          const full = path.join(dir, name);
          const st = await fs.stat(full);
          candidates.push({ path: full, mtimeMs: st.mtimeMs });
        }
      }
    }
    if (candidates.length === 0) {
      throw new ContractBuildError(
        `no wasm found under ${contractDir}/target/{${TARGET_DIRS.join(',')}}/release after build`,
      );
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0].path;
  }
}

async function assertFile(p: string, label: string): Promise<void> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) {
      throw new Error('not a file');
    }
  } catch {
    throw new ContractBuildError(`${label} does not exist or is not a file: ${p}`);
  }
}
