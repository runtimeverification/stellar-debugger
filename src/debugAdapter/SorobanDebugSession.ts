/**
 * The Soroban time-travel debug adapter: a DAP DebugSession that replays a
 * komet-node trace by moving a cursor over a TraceModel. Every stepping request
 * (forward and reverse) is a cursor move followed by a StoppedEvent.
 *
 * This module imports @vscode/debugadapter (a standalone Node library) but NOT
 * `vscode`, so the adapter can run in-process in the extension host while
 * remaining independent of the editor API.
 */

import {
  DebugSession,
  InitializedEvent,
  StoppedEvent,
  TerminatedEvent,
  OutputEvent,
  Thread,
  StackFrame,
  Scope,
  Source,
  Handles,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { TraceModel } from './TraceModel';
import { SourceMapper } from '../sourcemap/SourceMapper';
import { ResolvedTrace, SessionBackend, SorobanLaunchArgs } from './types';
import { TypedValue } from '../komet/trace';

const THREAD_ID = 1;
const FRAME_ID = 1;

/** Variable-reference handles for the two scopes we expose. */
enum ScopeRef {
  Locals = 1,
  Stack = 2,
}

export class SorobanDebugSession extends DebugSession {
  private readonly backend: SessionBackend;
  private model?: TraceModel;
  private source?: SourceMapper;

  /** Resolves when the client has finished configuring (e.g. breakpoints). */
  private configurationDone!: Promise<void>;
  private signalConfigurationDone!: () => void;

  /** Requested breakpoint lines, resolved to indices lazily via the source. */
  private breakpointLines: number[] = [];
  /** Container handles for structured variable expansion. */
  private readonly variableHandles = new Handles<TypedValue[]>();

  constructor(backend: SessionBackend) {
    super();
    this.backend = backend;
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.configurationDone = new Promise((resolve) => {
      this.signalConfigurationDone = resolve;
    });
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments,
  ): void {
    response.body = response.body ?? {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsStepBack = true; // enables stepBack AND reverseContinue
    response.body.supportsTerminateRequest = true;
    response.body.supportsRestartRequest = false;
    // Note: the InitializedEvent is deliberately NOT sent here. We only signal
    // readiness for breakpoints once the trace (and therefore the source the
    // breakpoints resolve against) has been loaded — see launchRequest.
    this.sendResponse(response);
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    args: DebugProtocol.ConfigurationDoneArguments,
  ): void {
    super.configurationDoneRequest(response, args);
    this.signalConfigurationDone();
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: SorobanLaunchArgs,
  ): Promise<void> {
    try {
      const resolved: ResolvedTrace = await this.backend.resolve(args, (msg) => this.log(msg));
      this.model = resolved.model;
      this.source = resolved.source;

      if (this.model.isEmpty) {
        this.sendErrorResponse(response, 2001, 'The trace is empty; nothing to debug.');
        this.sendEvent(new TerminatedEvent());
        return;
      }

      if (resolved.returnValue !== undefined) {
        this.log(`Invocation returned: ${resolved.returnValue}`);
      }
      this.log(`Loaded trace with ${this.model.length} instructions.`);

      // The source now exists, so it is safe to accept breakpoints. Signal
      // readiness and wait for the client to finish configuration.
      this.sendEvent(new InitializedEvent());
      await this.configurationDone;

      this.sendResponse(response);
      this.model.seek(0);
      this.sendEvent(new StoppedEvent('entry', THREAD_ID));
    } catch (e) {
      this.sendErrorResponse(response, 2000, `Failed to start debug session: ${(e as Error).message}`);
      this.sendEvent(new TerminatedEvent());
    }
  }

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
    const requested = args.breakpoints ?? (args.lines ?? []).map((line) => ({ line }));
    this.breakpointLines = requested.map((bp) => bp.line);

    const verified: DebugProtocol.Breakpoint[] = requested.map((bp) => ({
      verified: this.source ? this.source.indicesForLine(bp.line).length > 0 : true,
      line: bp.line,
    }));

    response.body = { breakpoints: verified };
    this.sendResponse(response);
  }

  /** Resolve the current breakpoint lines to trace indices via the source. */
  private resolvedBreakpointIndices(): Set<number> {
    const indices = new Set<number>();
    if (this.source) {
      for (const line of this.breakpointLines) {
        for (const i of this.source.indicesForLine(line)) {
          indices.add(i);
        }
      }
    }
    return indices;
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(THREAD_ID, 'soroban-vm')] };
    this.sendResponse(response);
  }

  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    _args: DebugProtocol.StackTraceArguments,
  ): void {
    if (!this.model || !this.source) {
      response.body = { stackFrames: [], totalFrames: 0 };
      this.sendResponse(response);
      return;
    }

    const loc = this.source.locationForIndex(this.model.cursor);
    const doc = this.source.getDocument();
    const src = new Source(doc.name, undefined, this.docSourceReference());
    const rec = this.model.current;
    const frameName = `${rec.instr.map((t) => String(t)).join(' ')}  [${this.model.cursor}/${this.model.length - 1}]`;

    const frame = new StackFrame(FRAME_ID, frameName, src, loc?.line ?? 1, loc?.column ?? 1);
    response.body = { stackFrames: [frame], totalFrames: 1 };
    this.sendResponse(response);
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    _args: DebugProtocol.ScopesArguments,
  ): void {
    response.body = {
      scopes: [
        new Scope('Locals', ScopeRef.Locals, false),
        new Scope('Value Stack', ScopeRef.Stack, false),
      ],
    };
    this.sendResponse(response);
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): void {
    const variables: DebugProtocol.Variable[] = [];
    const rec = this.model?.current;

    if (rec) {
      if (args.variablesReference === ScopeRef.Locals) {
        for (const [index, tv] of Object.entries(rec.locals)) {
          variables.push(this.makeVariable(`local[${index}]`, tv));
        }
      } else if (args.variablesReference === ScopeRef.Stack) {
        // Show top-of-stack first.
        for (let i = rec.stack.length - 1; i >= 0; i--) {
          variables.push(this.makeVariable(`[${rec.stack.length - 1 - i}]`, rec.stack[i]));
        }
      } else {
        // Nested container previously handed out via a handle.
        const container = this.variableHandles.get(args.variablesReference);
        if (container) {
          container.forEach((tv, i) => variables.push(this.makeVariable(`[${i}]`, tv)));
        }
      }
    }

    response.body = { variables };
    this.sendResponse(response);
  }

  protected sourceRequest(
    response: DebugProtocol.SourceResponse,
    _args: DebugProtocol.SourceArguments,
  ): void {
    const doc = this.source?.getDocument();
    response.body = { content: doc?.content ?? '', mimeType: 'text/plain' };
    this.sendResponse(response);
  }

  // --- Forward stepping -------------------------------------------------

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments,
  ): void {
    this.sendResponse(response);
    this.runForwardToBreakpoint();
  }

  protected nextRequest(
    response: DebugProtocol.NextResponse,
    _args: DebugProtocol.NextArguments,
  ): void {
    this.sendResponse(response);
    this.stopAfter(() => this.model?.stepOverForward() ?? false);
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    _args: DebugProtocol.StepInArguments,
  ): void {
    this.sendResponse(response);
    this.stopAfter(() => this.model?.stepForward() ?? false);
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    _args: DebugProtocol.StepOutArguments,
  ): void {
    this.sendResponse(response);
    this.stopAfter(() => this.model?.stepOutForward() ?? false);
  }

  // --- Reverse stepping (time travel) ----------------------------------

  protected stepBackRequest(
    response: DebugProtocol.StepBackResponse,
    _args: DebugProtocol.StepBackArguments,
  ): void {
    this.sendResponse(response);
    this.stopAfter(() => this.model?.stepOverBack() ?? false);
  }

  protected reverseContinueRequest(
    response: DebugProtocol.ReverseContinueResponse,
    _args: DebugProtocol.ReverseContinueArguments,
  ): void {
    this.sendResponse(response);
    this.runBackwardToBreakpoint();
  }

  // --- Teardown ---------------------------------------------------------

  protected async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): Promise<void> {
    try {
      await this.backend.dispose();
    } catch {
      // best-effort teardown
    }
    this.sendResponse(response);
  }

  protected async terminateRequest(
    response: DebugProtocol.TerminateResponse,
    _args: DebugProtocol.TerminateArguments,
  ): Promise<void> {
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  // --- Helpers ----------------------------------------------------------

  private runForwardToBreakpoint(): void {
    if (!this.model) {
      return;
    }
    const target = this.model.nextIndexInSet(this.resolvedBreakpointIndices());
    if (target !== null) {
      this.model.seek(target);
      this.sendEvent(new StoppedEvent('breakpoint', THREAD_ID));
    } else {
      this.model.seek(this.model.length - 1);
      // No further breakpoint: settle at the end of the recorded trace.
      this.sendEvent(new StoppedEvent('step', THREAD_ID));
    }
  }

  private runBackwardToBreakpoint(): void {
    if (!this.model) {
      return;
    }
    const target = this.model.prevIndexInSet(this.resolvedBreakpointIndices());
    if (target !== null) {
      this.model.seek(target);
      this.sendEvent(new StoppedEvent('breakpoint', THREAD_ID));
    } else {
      this.model.seek(0);
      this.sendEvent(new StoppedEvent('step', THREAD_ID));
    }
  }

  /** Apply a cursor move and emit a Stopped(step) event. */
  private stopAfter(move: () => boolean): void {
    move();
    this.sendEvent(new StoppedEvent('step', THREAD_ID));
  }

  private makeVariable(name: string, tv: TypedValue): DebugProtocol.Variable {
    const [type, value] = tv;
    return {
      name,
      value: `${formatValue(value)}`,
      type,
      variablesReference: 0,
    };
  }

  private docSourceReference(): number {
    // A single virtual document per session; a fixed non-zero reference tells
    // the client to fetch its content via a sourceRequest.
    return 1;
  }

  private log(message: string): void {
    this.sendEvent(new OutputEvent(`${message}\n`, 'console'));
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
