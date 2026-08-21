/**
 * The user-facing setup diagnostics: every message a missing or stale
 * dependency produces must name the thing that is missing, say how to get it,
 * and link to the README. These are pure string builders, so they are asserted
 * directly here and reused by the backends (see setupBackends.test.ts).
 */

import * as assert from 'assert';
import {
  README_URL,
  SetupError,
  TROUBLESHOOTING_URL,
  buildFailure,
  buildSpawnFailure,
  formatErrorDetail,
  isUserFacing,
  kometExitedEarly,
  kometSpawnFailure,
  kometUnreachable,
  staleKometRpc,
  staleKometTraceMessage,
  unreadableFile,
} from '../src/diagnostics/setup';

/** A Node spawn/fs error, as the runtime raises it. */
function errno(code: string, message = `${code}: something went wrong`): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = code;
  return err;
}

const ALL_ERRORS: (() => SetupError)[] = [
  () => kometSpawnFailure({ command: 'komet-node', error: errno('ENOENT') }),
  () => kometSpawnFailure({ command: '/opt/komet-node', error: errno('EACCES') }),
  () => kometSpawnFailure({ command: 'komet-node', error: errno('EMFILE') }),
  () => kometExitedEarly({ command: 'komet-node', code: 1, signal: null, output: ['boom'], port: 8000 }),
  () => kometUnreachable({ url: 'http://localhost:8000', attach: false, timeoutMs: 60_000, port: 8000 }),
  () => kometUnreachable({ url: 'http://localhost:8000', attach: true, timeoutMs: 60_000, port: 8000 }),
  () => buildFailure({ command: 'stellar contract build', cwd: '/w', code: 127, output: ['sh: 1: stellar: not found'] }),
  () => buildFailure({ command: 'stellar contract build', cwd: '/w', code: 101, output: ['boom'] }),
  () => buildSpawnFailure({ command: 'stellar contract build', error: errno('ENOENT') }),
  () => staleKometRpc('traceTransaction'),
  () => unreadableFile({ what: 'the recorded trace', path: '/x.jsonl', error: errno('ENOENT') }),
];

describe('setup diagnostics: the README link', () => {
  it('points at the README on GitHub', () => {
    assert.match(README_URL, /^https:\/\/github\.com\/runtimeverification\/stellar-debugger\b/);
    assert.match(README_URL, /README\.md$/);
    assert.ok(TROUBLESHOOTING_URL.startsWith(README_URL));
  });

  it('closes every setup error, and the stale-trace message, with the link', () => {
    for (const make of ALL_ERRORS) {
      const message = make().message;
      assert.ok(
        message.trimEnd().endsWith(TROUBLESHOOTING_URL + '.') || message.includes(TROUBLESHOOTING_URL),
        `missing the README link: ${message}`,
      );
    }
    assert.ok(staleKometTraceMessage('record 1 has no `kind` field').includes(TROUBLESHOOTING_URL));
  });

  it('writes messages as prose, not as error codes', () => {
    for (const make of ALL_ERRORS) {
      const first = make().message.split('\n')[0];
      // A leading `Error: ENOENT ...` style line is what we are replacing.
      assert.doesNotMatch(first, /^[A-Z]{4,}:/, `raw errno leaked into the first line: ${first}`);
      assert.ok(first.length > 20, `first line is not informative: ${first}`);
    }
  });
});

describe('setup diagnostics: komet-node cannot be started', () => {
  it('says the binary is not installed, how to install it, and how to point at it', () => {
    const message = kometSpawnFailure({ command: 'komet-node', error: errno('ENOENT') }).message;
    assert.match(message, /komet-node/);
    assert.match(message, /not found|no executable/i);
    assert.match(message, /kup install komet-node/);
    assert.match(message, /stellar\.kometNode\.path/);
    assert.match(message, /node\.command/);
  });

  it('mentions that replaying a recorded trace needs no komet-node at all', () => {
    const message = kometSpawnFailure({ command: 'komet-node', error: errno('ENOENT') }).message;
    assert.match(message, /rawTrace/);
  });

  it('names the configured path when one was configured', () => {
    const message = kometSpawnFailure({ command: '/opt/bin/komet-node', error: errno('ENOENT') }).message;
    assert.match(message, /\/opt\/bin\/komet-node/);
  });

  it('distinguishes a non-executable file from a missing one', () => {
    const message = kometSpawnFailure({ command: '/opt/bin/komet-node', error: errno('EACCES') }).message;
    assert.match(message, /not executable|permission/i);
    assert.match(message, /chmod \+x/);
    assert.doesNotMatch(message, /kup install/);
  });

  it('falls back to the underlying reason for an unexpected spawn failure', () => {
    const message = kometSpawnFailure({
      command: 'komet-node',
      error: errno('EMFILE', 'EMFILE: too many open files'),
    }).message;
    assert.match(message, /too many open files/);
    assert.match(message, /komet-node/);
  });
});

describe('setup diagnostics: komet-node started but did not serve', () => {
  it('reports an early exit with its code, its output, and the port hint', () => {
    const message = kometExitedEarly({
      command: 'komet-node',
      code: 1,
      signal: null,
      output: ['Address already in use', 'giving up'],
      port: 8000,
    }).message;
    assert.match(message, /exited/);
    assert.match(message, /code 1/);
    assert.match(message, /giving up/);
    assert.match(message, /port/);
    assert.match(message, /node\.port/);
  });

  it('reports a killing signal instead of an exit code when there is one', () => {
    const message = kometExitedEarly({
      command: 'komet-node',
      code: null,
      signal: 'SIGKILL',
      output: [],
      port: 8000,
    }).message;
    assert.match(message, /SIGKILL/);
  });

  it('explains a health-check timeout in spawn mode, with the knob to raise it', () => {
    const message = kometUnreachable({
      url: 'http://localhost:8000',
      attach: false,
      timeoutMs: 60_000,
      port: 8000,
    }).message;
    assert.match(message, /http:\/\/localhost:8000/);
    assert.match(message, /60/); // the timeout, in seconds or ms
    assert.match(message, /healthTimeoutMs/);
    assert.match(message, /node\.port/);
  });

  it('explains an attach-mode timeout as nothing listening, not as a missing install', () => {
    const message = kometUnreachable({
      url: 'http://127.0.0.1:9999',
      attach: true,
      timeoutMs: 500,
      port: 9999,
    }).message;
    assert.match(message, /http:\/\/127\.0\.0\.1:9999/);
    assert.match(message, /attach/);
    assert.match(message, /komet-node --host 127\.0\.0\.1 --port 9999|start .*komet-node/);
    assert.doesNotMatch(message, /kup install/);
  });
});

describe('setup diagnostics: the contract build', () => {
  const cwd = '/work/contract';

  it('names the missing Stellar CLI and the setting that points at it', () => {
    const message = buildFailure({
      command: 'stellar contract build',
      cwd,
      code: 127,
      output: ['sh: 1: stellar: not found'],
    }).message;
    assert.match(message, /stellar/);
    assert.match(message, /Stellar CLI/i);
    assert.match(message, /stellar\.cliPath/);
    assert.match(message, /buildCommand/);
    assert.match(message, /developers\.stellar\.org/);
  });

  it('recognizes the `bash: X: command not found` phrasing too', () => {
    const message = buildFailure({
      command: 'stellar contract build',
      cwd,
      code: 127,
      output: ['bash: stellar: command not found'],
    }).message;
    assert.match(message, /Stellar CLI/i);
  });

  it('recognizes the `zsh: command not found: X` phrasing too', () => {
    const message = buildFailure({
      command: 'cargo build',
      cwd,
      code: 127,
      output: ['zsh: command not found: cargo'],
    }).message;
    assert.match(message, /Rust/i);
    assert.match(message, /rustup/);
  });

  it('points at rustup when the Rust toolchain itself is missing', () => {
    const message = buildFailure({
      command: 'stellar contract build',
      cwd,
      code: 127,
      output: ['sh: 1: cargo: not found'],
    }).message;
    assert.match(message, /Rust/i);
    assert.match(message, /rustup/);
    assert.doesNotMatch(message, /stellar\.cliPath/);
  });

  it('points at `rustup target add` when the wasm target is missing', () => {
    const message = buildFailure({
      command: 'stellar contract build',
      cwd,
      code: 101,
      output: [
        "error[E0463]: can't find crate for `core`",
        'note: the `wasm32v1-none` target may not be installed',
      ],
    }).message;
    assert.match(message, /rustup target add wasm32v1-none/);
    assert.match(message, /wasm32-unknown-unknown/);
  });

  it('says the command is not the Stellar CLI when it rejects `contract build`', () => {
    const message = buildFailure({
      command: 'stellar contract build',
      cwd,
      code: 2,
      output: ["error: unrecognized subcommand 'contract'"],
    }).message;
    assert.match(message, /Stellar CLI/i);
    assert.match(message, /stellar\.cliPath/);
  });

  it('reports an unrecognized failure with the command, the directory, and the output tail', () => {
    const message = buildFailure({
      command: 'stellar contract build',
      cwd,
      code: 101,
      output: ['warning: unused import', 'error: could not compile `token`'],
    }).message;
    assert.match(message, /stellar contract build/);
    assert.match(message, /\/work\/contract/);
    assert.match(message, /code 101/);
    assert.match(message, /could not compile `token`/);
    // Still tells the reader what the build needs, since a toolchain problem
    // often surfaces as an ordinary compile failure.
    assert.match(message, /wasm32v1-none|Rust/);
  });

  it('keeps the output tail bounded', () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const message = buildFailure({ command: 'x', cwd, code: 1, output }).message;
    assert.match(message, /line 199/);
    assert.doesNotMatch(message, /line 100\b/);
    assert.ok(message.length < 2000, `message is ${message.length} chars`);
  });

  it('handles a build command that could not be launched at all', () => {
    const message = buildSpawnFailure({
      command: 'stellar contract build',
      error: errno('ENOENT', 'spawn /bin/sh ENOENT'),
    }).message;
    assert.match(message, /stellar contract build/);
    assert.match(message, /could not|failed/i);
  });
});

describe('setup diagnostics: a stale komet-node', () => {
  it('explains the old trace shape as a version problem, with the fix', () => {
    const message = staleKometTraceMessage('record 1 has no `kind` field');
    assert.match(message, /record 1 has no `kind` field/);
    assert.match(message, /komet v0\.1\.87/);
    assert.match(message, /kup install komet-node/);
    assert.match(message, /re-?record/i);
  });

  it('explains a missing traceTransaction method as a version problem', () => {
    const message = staleKometRpc('traceTransaction').message;
    assert.match(message, /traceTransaction/);
    assert.match(message, /too old|older/i);
    assert.match(message, /kup install komet-node/);
  });
});

describe('setup diagnostics: unreadable inputs', () => {
  it('explains a missing file in words, with what it was for', () => {
    const message = unreadableFile({
      what: 'the recorded trace (`rawTrace`)',
      path: '/traces/add.jsonl',
      error: errno('ENOENT', "ENOENT: no such file or directory, open '/traces/add.jsonl'"),
      hint: 'Record one with `stellar-trace --out add.jsonl`.',
    }).message;
    assert.match(message, /the recorded trace \(`rawTrace`\)/);
    assert.match(message, /\/traces\/add\.jsonl/);
    assert.match(message, /no such file/i);
    assert.match(message, /stellar-trace --out add\.jsonl/);
  });

  it('distinguishes a permission problem and a directory from a missing file', () => {
    const denied = unreadableFile({ what: 'the contract wasm', path: '/w/a.wasm', error: errno('EACCES') }).message;
    assert.match(denied, /permission/i);
    const isDir = unreadableFile({ what: 'the contract wasm', path: '/w', error: errno('EISDIR') }).message;
    assert.match(isDir, /directory/i);
  });
});

describe('setup diagnostics: how errors are printed', () => {
  it('marks setup errors as user-facing and plain errors as not', () => {
    assert.ok(isUserFacing(new SetupError('nope')));
    assert.ok(isUserFacing(kometSpawnFailure({ command: 'komet-node', error: errno('ENOENT') })));
    assert.ok(!isUserFacing(new Error('boom')));
    assert.ok(!isUserFacing('boom'));
    assert.ok(!isUserFacing(undefined));
  });

  it('prints a user-facing error as its message alone, with no stack trace', () => {
    const detail = formatErrorDetail(kometSpawnFailure({ command: 'komet-node', error: errno('ENOENT') }));
    assert.match(detail, /kup install komet-node/);
    assert.doesNotMatch(detail, /\n\s+at /);
    assert.doesNotMatch(detail, /SetupError/);
  });

  it('prints an unexpected error with its stack, so a bug stays diagnosable', () => {
    const detail = formatErrorDetail(new Error('boom'));
    assert.match(detail, /boom/);
    assert.match(detail, /\n\s+at /);
  });

  it('prints a non-error as itself', () => {
    assert.strictEqual(formatErrorDetail('just a string'), 'just a string');
  });
});

describe('setup diagnostics: a missing program we cannot classify', () => {
  it('names it without claiming to know which dependency it is', () => {
    const message = buildFailure({
      command: 'my-wrapper build',
      cwd: '/w',
      code: 127,
      output: ['sh: 1: my-wrapper: not found'],
    }).message;
    assert.match(message, /my-wrapper/);
    assert.match(message, /buildCommand/);
    // Guessing "install the Stellar CLI" here would be a confident wrong answer.
    assert.doesNotMatch(message, /Install the Stellar CLI/);
    assert.doesNotMatch(message, /rustup/);
  });
});
