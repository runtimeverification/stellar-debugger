/**
 * Extension entry point. Wires the Stellar debug type into VSCode:
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
import { backendFor } from './debugAdapter/backendFor';
import { SorobanLaunchArgs } from './debugAdapter/types';
import { TROUBLESHOOTING_URL } from './diagnostics/setup';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SorobanConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('stellar', provider),
    vscode.debug.registerDebugAdapterDescriptorFactory('stellar', new SorobanAdapterFactory()),
    vscode.commands.registerCommand('stellar.debug', () => startDebugFromActiveEditor()),
  );
}

export function deactivate(): void {
  // No global resources to release; sessions clean up on disconnect.
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
      config.type = 'stellar';
      config.request = 'launch';
      config.name = 'Stellar: Debug';
    }
    if (config.request === undefined) {
      config.request = 'launch';
    }
    applyBinaryPaths(config, folder);
    if (!config.rawTrace && !Array.isArray(config.transactions)) {
      return vscode.window
        .showErrorMessage(
          'Stellar debug: a `transactions` array (or a `rawTrace` file) is required in the launch ' +
            `configuration. See ${TROUBLESHOOTING_URL}.`,
        )
        .then(() => undefined);
    }
    return config;
  }
}

/**
 * Resolve the locations of the external binaries the pipeline shells out to
 * (`komet-node` and the `stellar` CLI). A launch configuration's own fields win;
 * otherwise fall back to the `stellar.*` settings, which default to the binaries
 * on `$PATH`. This keeps the `vscode`-free pipeline modules oblivious to VSCode
 * settings — they just receive a resolved command.
 */
function applyBinaryPaths(
  config: vscode.DebugConfiguration,
  folder: vscode.WorkspaceFolder | undefined,
): void {
  const settings = vscode.workspace.getConfiguration('stellar', folder?.uri ?? null);
  const kometNodePath = settings.get<string>('kometNode.path')?.trim() || 'komet-node';
  const stellarPath = settings.get<string>('stellar.path')?.trim() || 'stellar';

  // komet-node is spawned directly (no shell), so a path with spaces is fine verbatim.
  config.node = config.node ?? {};
  if (!config.node.command) {
    config.node.command = kometNodePath;
  }
  // Inject the resolved build command into any `deploy` step that doesn't set
  // its own, so the `stellar.cliPath` setting still applies under the
  // `transactions` schema. The build command runs through a shell, so quote a
  // path that contains spaces.
  const buildCommand = `${quoteForShell(stellarPath)} contract build`;
  if (Array.isArray(config.transactions)) {
    for (const step of config.transactions) {
      if (step && step.kind === 'deploy' && !step.buildCommand) {
        step.buildCommand = buildCommand;
      }
    }
  }
}

function quoteForShell(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

async function startDebugFromActiveEditor(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('Stellar debug: open a workspace folder first.');
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
    type: 'stellar',
    request: 'launch',
    name: `Stellar: Debug ${fn}`,
    transactions: [
      { kind: 'deploy', id: 'contract', contract: folder.uri.fsPath },
      { kind: 'invoke', contract: 'contract', function: fn },
    ],
  });
}
