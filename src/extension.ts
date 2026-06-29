/**
 * Extension entry point. Wires the Soroban debug type into VSCode:
 *   - a DebugConfigurationProvider that fills in sensible defaults, and
 *   - an inline DebugAdapterDescriptorFactory that runs the trace-replay
 *     DebugSession in-process (the trace is fully materialized, so there is no
 *     need for a separate adapter process).
 *
 * This is the only module that imports `vscode`; all replay logic lives in
 * `vscode`-free modules so it can be unit-tested in plain Node.
 */

import * as vscode from 'vscode';
import { SorobanDebugSession } from './debugAdapter/SorobanDebugSession';
import { RawTraceBackend } from './debugAdapter/backends/RawTraceBackend';
import { LiveBackend } from './debugAdapter/backends/LiveBackend';
import { SessionBackend, SorobanLaunchArgs } from './debugAdapter/types';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SorobanConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('soroban', provider),
    vscode.debug.registerDebugAdapterDescriptorFactory('soroban', new SorobanAdapterFactory()),
    vscode.commands.registerCommand('soroban.debug', () => startDebugFromActiveEditor()),
    vscode.commands.registerCommand('soroban.showWat', () => {
      vscode.window.showInformationMessage('Soroban: disassembly view arrives in M4.');
    }),
  );
}

export function deactivate(): void {
  // No global resources to release; sessions clean up on disconnect.
}

/** Selects a backend per launch configuration. */
function backendFor(config: SorobanLaunchArgs): SessionBackend {
  if (config.rawTrace) {
    return new RawTraceBackend();
  }
  return new LiveBackend();
}

class SorobanAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const backend = backendFor(session.configuration as unknown as SorobanLaunchArgs);
    return new vscode.DebugAdapterInlineImplementation(new SorobanDebugSession(backend) as any);
  }
}

class SorobanConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (!config.type && !config.request && !config.name) {
      // Launched with no launch.json: offer a minimal default if a function name
      // can't be inferred, bail with a hint.
      config.type = 'soroban';
      config.request = 'launch';
      config.name = 'Soroban: Debug';
    }
    if (config.request === undefined) {
      config.request = 'launch';
    }
    if (!config.contract && !config.wasmPath && !config.rawTrace && folder) {
      config.contract = folder.uri.fsPath;
    }
    if (!config.function && !config.rawTrace) {
      return vscode.window
        .showErrorMessage('Soroban debug: a `function` (or a `rawTrace` file) is required in the launch configuration.')
        .then(() => undefined);
    }
    return config;
  }
}

async function startDebugFromActiveEditor(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('Soroban debug: open a workspace folder first.');
    return;
  }
  const fn = await vscode.window.showInputBox({
    prompt: 'Contract function to debug',
    placeHolder: 'e.g. add',
  });
  if (!fn) {
    return;
  }
  await vscode.debug.startDebugging(folder, {
    type: 'soroban',
    request: 'launch',
    name: `Soroban: Debug ${fn}`,
    contract: folder.uri.fsPath,
    function: fn,
    args: [],
  });
}
