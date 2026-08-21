/**
 * The messages a user reads when one of the debugger's external dependencies is
 * missing, unusable, or too old.
 *
 * Every failure of that kind is expressible as a `SetupError`, whose message is
 * written for a person: it says what could not be done, why, what to run or set
 * to fix it, and — always as the last line — where to read more. Nothing here
 * knows about VSCode or DAP, so the same wording reaches the editor modal, the
 * debug console, `stellar-trace` and `stellar-dap`.
 *
 * The four situations these cover, and where each is raised:
 *   - komet-node cannot be spawned, or dies before serving   (komet/KometProcess)
 *   - komet-node never answers, or answers too old           (backends/LiveBackend,
 *                                                            pipeline/SequenceRunner,
 *                                                            komet/trace)
 *   - the contract build fails for want of a toolchain       (build/ContractBuilder)
 *   - an input file (trace, wasm) cannot be read             (both backends)
 *
 * Pure module (no `vscode`, no I/O): the factories are string builders, unit
 * tested directly in test/setupErrors.test.ts.
 */

/** The README, which carries the requirements and the troubleshooting table. */
export const README_URL = 'https://github.com/runtimeverification/stellar-debugger/blob/main/README.md';

/** Where every setup error sends the reader for the longer version. */
export const TROUBLESHOOTING_URL = `${README_URL}#troubleshooting`;

/** Where the Stellar CLI itself is documented. */
const STELLAR_CLI_URL = 'https://developers.stellar.org/docs/tools/cli';

/** Where a Rust toolchain comes from. */
const RUSTUP_URL = 'https://rustup.rs';

/** The wasm targets a Soroban contract builds to, newest first. */
const WASM_TARGETS = ['wasm32v1-none', 'wasm32-unknown-unknown'];

/**
 * A dependency problem, phrased for the person who has to fix it. The message
 * is assembled from paragraphs and always closes with the README link, so no
 * caller can forget it.
 */
export class SetupError extends Error {
  /** Marks a message meant for a user: printed as prose, without a stack. */
  readonly userFacing = true;

  constructor(...paragraphs: string[]) {
    super(setupMessage(...paragraphs));
    this.name = 'SetupError';
  }
}

/** Join paragraphs into a user-facing message and append the README link. */
export function setupMessage(...paragraphs: string[]): string {
  const body = paragraphs.filter((p) => p.length > 0);
  return [...body, `See ${TROUBLESHOOTING_URL}.`].join('\n');
}

/**
 * Whether an error carries a message written for the user. Checked by the flag
 * rather than by class so that `StaleTraceError` — which must stay a
 * `TraceParseError` for existing handlers — can opt in too.
 */
export function isUserFacing(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { userFacing?: unknown }).userFacing === true;
}

/**
 * How an error should be logged. A setup error is already the explanation, so
 * its stack is noise; anything else is a bug, whose stack is the whole point.
 */
export function formatErrorDetail(e: unknown): string {
  if (isUserFacing(e)) {
    return (e as Error).message;
  }
  if (e instanceof Error) {
    return e.stack ?? e.message;
  }
  return String(e);
}

// --- komet-node: cannot be started ---------------------------------------

/** Where to say a komet-node path can be corrected. */
const KOMET_PATH_HINT =
  'Set the `stellar.kometNode.path` setting (or `node.command` in your launch configuration) ' +
  'to its full path if it lives somewhere off your `PATH`.';

const KOMET_WHAT =
  'komet-node is the local Stellar network the debugger runs your contract on; ' +
  'it must bundle komet v0.1.87 or newer.';

const REPLAY_NEEDS_NOTHING =
  'Replaying an already-recorded trace (the `rawTrace` launch attribute) needs no komet-node at all.';

/** komet-node could not be spawned: not installed, not executable, or worse. */
export function kometSpawnFailure(opts: {
  command: string;
  error: NodeJS.ErrnoException;
}): SetupError {
  const { command, error } = opts;
  const where = command.includes('/') ? `at \`${command}\`` : `named \`${command}\` on your \`PATH\``;

  if (error.code === 'ENOENT') {
    return new SetupError(
      `komet-node could not be started: there is no executable ${where}.`,
      `${KOMET_WHAT} Install it with \`kup install komet-node\`. ${KOMET_PATH_HINT}`,
      REPLAY_NEEDS_NOTHING,
    );
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return new SetupError(
      `komet-node could not be started: \`${command}\` is not executable (permission denied).`,
      `Make it executable with \`chmod +x ${command}\`, or point \`stellar.kometNode.path\` at the right file.`,
    );
  }
  return new SetupError(
    `komet-node could not be started: ${error.message}`,
    `The command was \`${command}\`. ${KOMET_PATH_HINT}`,
  );
}

/** komet-node started and then exited before it was ready to serve. */
export function kometExitedEarly(opts: {
  command: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  output: readonly string[];
  port: number;
}): SetupError {
  const { command, code, signal, output, port } = opts;
  const how = signal ? `was killed by ${signal}` : `exited with code ${code ?? 'unknown'}`;
  return new SetupError(
    `komet-node ${how} before it was ready to serve requests.`,
    outputParagraph('Its last output was', output),
    `A common cause is port ${port} already being in use — another komet-node may still be running. ` +
      'Set `node.port` in your launch configuration to a free port, or stop the other process. ' +
      `The command was \`${command}\`.`,
  );
}

/** Nothing answered the health check within the deadline. */
export function kometUnreachable(opts: {
  url: string;
  attach: boolean;
  timeoutMs: number;
  port: number;
}): SetupError {
  const { url, attach, timeoutMs, port } = opts;
  const waited = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
  const host = hostOf(url);

  if (attach) {
    return new SetupError(
      `No komet-node answered at ${url} within ${waited}.`,
      'Your launch configuration sets `node.attach`, so the debugger did not start a node itself. ' +
        `Start one with \`komet-node --host ${host} --port ${port}\` and launch again, ` +
        'or drop `node.attach` and let the debugger spawn it for you.',
    );
  }
  return new SetupError(
    `komet-node did not become ready within ${waited}: it is running, but it never answered ` +
      `the health check at ${url}.`,
    'Its own output is in the log above (the Debug Console, in the editor) and usually says why. ' +
      'A very large contract can simply need longer to boot — raise `node.healthTimeoutMs` in your ' +
      `launch configuration. If something else is holding port ${port}, set \`node.port\` to a free one.`,
  );
}

// --- komet-node: too old --------------------------------------------------

const KOMET_UPGRADE = 'Upgrade it with `kup install komet-node`, then run again.';

/**
 * The message for a trace whose records predate komet v0.1.87. Exposed as a
 * string (not an error) because `komet/trace.ts` must raise it as a
 * `TraceParseError` subclass to stay compatible with existing handlers.
 */
export function staleKometTraceMessage(detail: string): string {
  return setupMessage(
    'This execution trace was recorded by a komet-node that is too old for this version of the ' +
      `debugger (${detail}; that field arrived in komet v0.1.87).`,
    `${KOMET_UPGRADE} If you are replaying a saved trace file, re-record it with the upgraded node — ` +
      'the debugger refuses to replay the old shape rather than show you a session with every state ' +
      'view mysteriously empty.',
  );
}

/** komet-node does not implement an RPC method the debugger needs. */
export function staleKometRpc(method: string): SetupError {
  return new SetupError(
    `komet-node does not support the \`${method}\` request, which the debugger needs to record an ` +
      'execution.',
    `The installed node is older than komet v0.1.87 (or is not komet-node at all). ${KOMET_UPGRADE}`,
  );
}

// --- the contract build --------------------------------------------------

const BUILD_NEEDS =
  'Building a contract needs a Rust toolchain with a WebAssembly target ' +
  `(\`${WASM_TARGETS[0]}\`) and the Stellar CLI.`;

/** The build command could not be launched at all (no shell, and the like). */
export function buildSpawnFailure(opts: { command: string; error: NodeJS.ErrnoException }): SetupError {
  return new SetupError(
    `The contract build could not be started: ${opts.error.message}`,
    `The build command was \`${opts.command}\`. ${BUILD_NEEDS}`,
  );
}

/**
 * The build ran and failed. The output is classified — a missing program, a
 * missing wasm target, a command that is not the Stellar CLI — so the message
 * names the fix instead of only the exit code.
 */
export function buildFailure(opts: {
  command: string;
  cwd: string;
  code: number | null;
  signal?: NodeJS.Signals | null;
  output: readonly string[];
}): SetupError {
  const { command, cwd, code, signal, output } = opts;
  const text = output.join('\n');

  // 1. A program the build wanted is not installed. The shell says so on
  //    stderr; exit 127 says so on its own when the output was swallowed.
  const missing = missingProgram(text) ?? (code === 127 ? firstWord(command) : undefined);
  if (missing !== undefined) {
    return missingProgramError(missing, command);
  }

  // 2. The toolchain is there, but not the target the contract compiles to.
  if (/target may not be installed|can't find crate for `core`|no such target/i.test(text)) {
    return new SetupError(
      'The contract build failed: the Rust WebAssembly target is missing.',
      `Install it with \`rustup target add ${WASM_TARGETS[0]}\` ` +
        `(toolchains older than Rust 1.84 use \`${WASM_TARGETS[1]}\` instead), then build again.`,
      outputParagraph('The build said', output),
    );
  }

  // 3. Something answered, but it is not the Stellar CLI.
  if (/unrecognized subcommand|no such subcommand|no such command|unknown command/i.test(text)) {
    return new SetupError(
      `The contract build failed: \`${firstWord(command)}\` does not understand \`contract build\`, ` +
        'so it does not appear to be the Stellar CLI.',
      `Install the Stellar CLI (${STELLAR_CLI_URL}) and point the \`stellar.cliPath\` setting — or a ` +
        "deploy step's `buildCommand` — at it.",
      outputParagraph('The command said', output),
    );
  }

  // 4. An ordinary build failure. The output is the answer; we add what the
  //    build needs, because a toolchain problem often surfaces this way.
  const how = signal ? `was killed by ${signal}` : `exited with code ${code ?? 'unknown'}`;
  return new SetupError(
    `The contract build failed: \`${command}\` ${how} in ${cwd}.`,
    outputParagraph('Its last output was', output),
    `The full build log is above. ${BUILD_NEEDS}`,
  );
}

/** The build produced no wasm, so there is nothing to deploy. */
export function noWasmProduced(opts: { contractDir: string; command: string }): SetupError {
  return new SetupError(
    'The contract build reported success but produced no WebAssembly file.',
    `Nothing was found under \`${opts.contractDir}/target/{${WASM_TARGETS.join(',')}}/release\`. ` +
      `Check that this directory is a Soroban contract crate (a \`Cargo.toml\` with ` +
      `\`crate-type = ["cdylib"]\`) and that \`${opts.command}\` really builds it.`,
  );
}

/** Phrase a missing program as the dependency it belongs to. */
function missingProgramError(program: string, command: string): SetupError {
  const base = program.split('/').pop() ?? program;

  if (/^(cargo|rustc|rustup)(\.exe)?$/i.test(base)) {
    return new SetupError(
      `The contract build failed: \`${base}\` was not found, so there is no Rust toolchain to build with.`,
      `Install one from ${RUSTUP_URL}, then add the WebAssembly target with ` +
        `\`rustup target add ${WASM_TARGETS[0]}\`.`,
    );
  }
  // Only a name that reads as the Stellar CLI is diagnosed as one: telling
  // someone their missing `foo` is a missing Stellar CLI would be a wrong
  // answer stated confidently.
  const isStellarCli = /^stellar(\b|[-_.])/i.test(base);
  return new SetupError(
    `The contract build failed: \`${program}\` was not found (the build command was \`${command}\`).`,
    isStellarCli
      ? `Install the Stellar CLI (${STELLAR_CLI_URL}), or point the \`stellar.cliPath\` setting — or a ` +
        "deploy step's `buildCommand` — at the executable you want to build with."
      : `Install it, or change the \`buildCommand\` of that deploy step. ${BUILD_NEEDS}`,
  );
}

/** Shells name themselves when they report a missing program; skip those. */
const SHELL_NAMES = /^(sh|bash|zsh|dash|ksh|fish|cmd|powershell)$/i;

/**
 * The program name a shell reports as missing. Covers the three phrasings in
 * the wild: `sh: 1: foo: not found`, `bash: foo: command not found`, and
 * `zsh: command not found: foo`. The trailing-name form is tried first, since
 * its prefix also matches the leading-name form (with the shell as the name).
 */
function missingProgram(output: string): string | undefined {
  const name =
    /command not found: ([^\s:]+)/m.exec(output)?.[1] ??
    /(?:^|[\s:])([^\s:]+): (?:command )?not found/m.exec(output)?.[1];
  return name !== undefined && SHELL_NAMES.test(name) ? undefined : name;
}

// --- unreadable inputs ---------------------------------------------------

/** A file the launch configuration points at cannot be read. */
export function unreadableFile(opts: {
  what: string;
  path: string;
  error: NodeJS.ErrnoException;
  hint?: string;
}): SetupError {
  return new SetupError(
    `Cannot read ${opts.what} at \`${opts.path}\`: ${fsReason(opts.error)}.`,
    opts.hint ?? '',
  );
}

/** A filesystem error code as a phrase, falling back to the raw message. */
function fsReason(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case 'ENOENT':
      return 'no such file or directory';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EISDIR':
      return 'that path is a directory, not a file';
    case 'ENOTDIR':
      return 'a component of that path is not a directory';
    default:
      return error.message;
  }
}

// --- shared helpers ------------------------------------------------------

/** How many trailing output lines a message quotes. */
const TAIL_LINES = 8;
/** How much of one quoted line survives. */
const TAIL_LINE_CHARS = 160;
/** How much quoted output a message carries in total. */
const TAIL_CHARS = 700;

/**
 * The tail of a process's output, indented under a lead-in. Bounded on both
 * axes: a message has to stay readable in a modal dialog, and the full log is
 * in the debug console (or on stderr) anyway.
 */
function outputParagraph(lead: string, output: readonly string[]): string {
  const lines = output
    .flatMap((chunk) => chunk.split('\n'))
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-TAIL_LINES)
    .map((line) => (line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS)}…` : line));

  while (lines.length > 1 && lines.join('\n').length > TAIL_CHARS) {
    lines.shift();
  }
  if (lines.length === 0) {
    return '';
  }
  return [`${lead}:`, ...lines.map((line) => `  ${line}`)].join('\n');
}

/** The program a shell command runs, for naming it in a message. */
function firstWord(command: string): string {
  return command.trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
}

/** The host part of a `http://host:port` URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'localhost';
  }
}
