/**
 * The Soroban time-travel debug adapter: a DAP DebugSession that replays a
 * komet-node trace by moving a cursor over a TraceModel. Every stepping request
 * (forward and reverse) is a cursor move followed by a StoppedEvent.
 *
 * This module is deliberately thin — it owns the DAP conversation and nothing
 * else. The stepping rules live in `replayCursor.ts`, the stop-point derivation
 * in `stopModel.ts`, and each scope's presentation in a `*View` module; all of
 * them are pure and unit-testable on their own.
 *
 * It imports @vscode/debugadapter (a standalone Node library) but NOT `vscode`,
 * so the adapter can run in-process in the extension host while remaining
 * independent of the editor API.
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
import * as path from 'path';
import { TraceModel } from './TraceModel';
import { firstNonWhitespaceColumn } from './stops';
import { StopModel, buildStopModel } from './stopModel';
import { Granularity, ReplayCursor, resolveBreakpoints } from './replayCursor';
import { SourceMapper } from '../sourcemap/SourceMapper';
import { VariableResolver, NullVariableResolver } from '../sourcemap/VariableResolver';
import { Disassembly } from '../wasm/Disassembly';
import { ResolvedTrace, SessionBackend, SorobanLaunchArgs } from './types';
import { CallFrame, buildCallStack } from './callStack';
import { TraceRecord } from '../komet/trace';
import { disassemblyRows, formatAddress, parseAddress } from './disassemblyView';
import { ledgerNodes, ledgerSnapshot } from './ledgerView';
import { globalNodes, localNodes, stackNodes } from './wasmView';
import { makeRuntimeState } from './runtimeState';
import { DecodedValue, ChildVar } from '../dwarf/ValueDecoder';

const THREAD_ID = 1;

/**
 * The kinds of scope a frame can offer. A `variablesReference` encodes the kind
 * TOGETHER with the frame it belongs to (see `scopeRef`), because every scope is
 * now per-frame: selecting an outer frame must show that frame's state, not the
 * innermost one's (docs/callstack.md, C7).
 */
enum ScopeKind {
  Locals = 1,
  Stack = 2,
  SourceVars = 3,
  /** WASM globals of the executing module (docs/state-inspection.md, G2). */
  Globals = 4,
  /** Stellar ledger state at the cursor (docs/state-inspection.md, L1–L15). */
  Ledger = 5,
}

/** How many scope kinds a frame's reference block reserves. */
const SCOPES_PER_FRAME = 8;
/** Frame ids are `FRAME_ID_BASE + level`, so frame 0 is a valid (non-zero) id. */
const FRAME_ID_BASE = 1;
/** Scope references live above every frame id, child handles above every scope. */
const SCOPE_REF_BASE = 100_000;
const CHILD_HANDLE_BASE = 1_000_000;

/** The `variablesReference` naming scope `kind` of the frame at `level`. */
function scopeRef(level: number, kind: ScopeKind): number {
  return SCOPE_REF_BASE + level * SCOPES_PER_FRAME + kind;
}

/** Inverse of `scopeRef`, or null when the reference is not a scope. */
function decodeScopeRef(reference: number): { level: number; kind: ScopeKind } | null {
  if (reference < SCOPE_REF_BASE || reference >= CHILD_HANDLE_BASE) {
    return null;
  }
  const offset = reference - SCOPE_REF_BASE;
  return { level: Math.floor(offset / SCOPES_PER_FRAME), kind: offset % SCOPES_PER_FRAME };
}

export class SorobanDebugSession extends DebugSession {
  /**
   * Either a concrete backend or a selector resolved on the first line of
   * launchRequest (the TCP server passes the selector so the backend can depend
   * on the per-connection launch config). Once launched, this holds the
   * concrete backend.
   */
  private backend: SessionBackend | ((args: SorobanLaunchArgs) => SessionBackend);
  private resolved?: ResolvedTrace;
  private model?: TraceModel;
  private cursor?: ReplayCursor;
  private stops?: StopModel;
  private source?: SourceMapper;
  private disassembly?: Disassembly;
  /**
   * The call stack at the current cursor, built once per stop: `stackTrace` and
   * every following `scopes`/`variables` request must agree on what frame N is.
   * Cleared whenever the cursor moves (see `reportStop`).
   */
  private frames?: CallFrame[];

  /** Resolves when the client has finished configuring (e.g. breakpoints). */
  private readonly configurationDone: Promise<void>;
  private signalConfigurationDone!: () => void;

  /**
   * Source breakpoints as requested by the client, keyed by normalized file
   * path. Re-resolved to trace indices on every use (cheap) via the mapper.
   */
  private readonly sourceBreakpoints = new Map<string, DebugProtocol.SourceBreakpoint[]>();
  /** Instruction breakpoints as requested code offsets (verified or not). */
  private instructionBreakpointAddrs: number[] = [];
  /** Source-level variable resolver (Null until a DWARF-bearing wasm loads). */
  private variables: VariableResolver = new NullVariableResolver();
  /**
   * Handles for lazily-expanded variable children. Starts above every frame id
   * and per-frame scope reference; reset on every stop so refs are fresh per
   * cursor position (DAP invalidates all references at a stop).
   */
  private readonly childHandles = new Handles<() => ChildVar[]>(CHILD_HANDLE_BASE);

  /**
   * Set once the per-connection backend has been disposed, so teardown is
   * idempotent: a clean `disconnect` disposes, and the subsequent socket
   * 'close'/'error' from the TCP server must NOT dispose the (already torn
   * down) komet-node pipeline a second time.
   */
  private disposed = false;

  constructor(backend: SessionBackend | ((args: SorobanLaunchArgs) => SessionBackend)) {
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
    response.body.supportsSteppingGranularity = true;
    response.body.supportsDisassembleRequest = true;
    response.body.supportsInstructionBreakpoints = true;
    response.body.supportsBreakpointLocationsRequest = true;
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
    // Resolve the backend selector (TCP server) to a concrete backend now that
    // the per-connection launch config is known; a concrete backend passes
    // through unchanged.
    if (typeof this.backend === 'function') {
      this.backend = this.backend(args);
    }
    try {
      const resolved: ResolvedTrace = await this.backend.resolve(args, (msg) => this.log(msg));
      this.resolved = resolved;
      this.model = resolved.model;
      this.source = resolved.source;
      this.variables = resolved.variables;
      this.disassembly = resolved.disassembly;
      this.stops = buildStopModel(resolved, { justMyCode: args.justMyCode });
      this.cursor = new ReplayCursor(this.model, this.stops);

      if (this.model.isEmpty) {
        this.sendErrorResponse(response, 2001, 'The trace is empty; nothing to debug.');
        this.sendEvent(new TerminatedEvent());
        return;
      }

      const returnValue = this.model.returnValue;
      if (returnValue !== undefined) {
        this.log(`Invocation returned: ${returnValue}`);
      }
      this.log(`Loaded trace with ${this.model.length} instructions.`);

      // The source now exists, so it is safe to accept breakpoints. Signal
      // readiness and wait for the client to finish configuration.
      this.sendEvent(new InitializedEvent());
      await this.configurationDone;

      this.sendResponse(response);
      this.cursor.toEntry();
      this.reportStop('entry');
    } catch (e) {
      // sendErrorResponse surfaces only a one-line, non-copyable modal. Mirror
      // the full error (with stack) into the debug console first, so the details
      // land in the same copyable log as the rest of the launch output.
      const message = e instanceof Error ? e.message : String(e);
      const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.log(`Failed to start debug session: ${detail}`);
      this.sendErrorResponse(response, 2000, `Failed to start debug session: ${message}`);
      this.sendEvent(new TerminatedEvent());
    }
  }

  // --- Breakpoints ------------------------------------------------------

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
    const requested: DebugProtocol.SourceBreakpoint[] =
      args.breakpoints ?? (args.lines ?? []).map((line) => ({ line }));
    const sourcePath = args.source.path;
    if (sourcePath !== undefined) {
      // DAP semantics: each request carries ALL breakpoints for that source,
      // so the stored entry is replaced wholesale.
      this.sourceBreakpoints.set(path.normalize(sourcePath), requested);
    }

    // The response is parallel to the request; a verified breakpoint may carry
    // a line adjusted forward to the nearest executed one.
    const breakpoints: DebugProtocol.Breakpoint[] = requested.map((bp) => {
      if (sourcePath === undefined || !this.source || !this.source.hasLineInfo()) {
        return { verified: false, line: bp.line };
      }
      const resolved = this.source.resolveBreakpoint(sourcePath, bp.line);
      if (resolved === null) {
        return {
          verified: false,
          line: bp.line,
          message: 'No executed code maps to this line in the recorded trace.',
        };
      }
      return { verified: true, line: resolved.line };
    });

    response.body = { breakpoints };
    this.sendResponse(response);
  }

  protected breakpointLocationsRequest(
    response: DebugProtocol.BreakpointLocationsResponse,
    args: DebugProtocol.BreakpointLocationsArguments,
  ): void {
    const sourcePath = args.source.path;
    const lines =
      sourcePath !== undefined && this.source
        ? this.source.executedLines(sourcePath, args.line, args.endLine ?? args.line)
        : [];
    response.body = { breakpoints: lines.map((line) => ({ line })) };
    this.sendResponse(response);
  }

  protected setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments,
  ): void {
    // DAP semantics: each request carries ALL instruction breakpoints, so the
    // stored list is replaced wholesale.
    this.instructionBreakpointAddrs = args.breakpoints.map(
      (bp) => parseAddress(bp.instructionReference) + (bp.offset ?? 0),
    );

    const verifiedAt = this.stops?.validatedPosToIndices;
    const breakpoints: DebugProtocol.Breakpoint[] = this.instructionBreakpointAddrs.map((addr) => {
      const verified = verifiedAt?.has(addr) ?? false;
      return {
        verified,
        ...(verified
          ? {}
          : { message: 'No executed instruction at this address in the recorded trace.' }),
      };
    });

    response.body = { breakpoints };
    this.sendResponse(response);
  }

  /** The trace indices all stored breakpoints currently resolve to. */
  private breakpointIndices(): Set<number> {
    if (!this.stops) {
      return new Set();
    }
    return resolveBreakpoints(
      this.stops,
      this.source,
      this.sourceBreakpoints,
      this.instructionBreakpointAddrs,
    );
  }

  // --- Frames, disassembly, scopes --------------------------------------

  /**
   * The single VM thread. Its label carries the cursor's position in the
   * recording — the one fact a time-travel session has and DAP's frame model
   * does not, and which a client refreshes on every stop.
   */
  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    const position =
      this.model && !this.model.isEmpty ? ` [${this.model.cursor}/${this.model.length - 1}]` : '';
    response.body = { threads: [new Thread(THREAD_ID, `soroban-vm${position}`)] };
    this.sendResponse(response);
  }

  /**
   * The full call stack at the cursor (docs/callstack.md), innermost frame
   * first, honoring the client's paging window. Every frame is selectable and
   * carries its own source position and instruction pointer; a contract-boundary
   * frame is reported as a `label` so clients render it as the marker it is.
   */
  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ): void {
    const frames = this.callFrames();
    const start = args.startFrame ?? 0;
    const end = args.levels && args.levels > 0 ? start + args.levels : frames.length;
    response.body = {
      stackFrames: frames.slice(start, end).map((frame) => this.toDapFrame(frame)),
      totalFrames: frames.length,
    };
    this.sendResponse(response);
  }

  /** The call stack at the cursor, built once per stop. */
  private callFrames(): CallFrame[] {
    if (this.frames === undefined) {
      this.frames =
        this.resolved && this.stops && !this.resolved.model.isEmpty
          ? buildCallStack(
              { resolved: this.resolved, frames: this.stops.frames, ranges: this.stops.ranges },
              this.resolved.model.cursor,
            )
          : [];
    }
    return this.frames;
  }

  /**
   * One `CallFrame` as DAP. S19: a mapped frame reports its line's first
   * non-whitespace column, not the arbitrary DWARF sub-expression column; the
   * DWARF column is the fallback when the line text is unavailable or
   * all-whitespace. An unmapped frame gets no Source at all (and line 0), so the
   * client keeps showing the frame name instead of opening a wrong file.
   */
  private toDapFrame(frame: CallFrame): DebugProtocol.StackFrame {
    const id = FRAME_ID_BASE + frame.level;
    const loc = frame.source;
    const dap: DebugProtocol.StackFrame = loc
      ? new StackFrame(
          id,
          frame.name,
          new Source(path.basename(loc.path), loc.path),
          loc.line,
          firstNonWhitespaceColumn(this.source?.sourceTextAt(loc.path, loc.line) ?? null) ??
            loc.column ??
            0,
        )
      : new StackFrame(id, frame.name);
    if (frame.kind === 'contract') {
      dap.presentationHint = 'label';
    } else if (frame.subtle) {
      dap.presentationHint = 'subtle';
      if (dap.source) {
        dap.source.presentationHint = 'deemphasize';
      }
    }
    if (frame.pc !== null) {
      dap.instructionPointerReference = formatAddress(frame.pc);
    }
    return dap;
  }

  protected disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments,
  ): void {
    response.body = { instructions: disassemblyRows(this.disassembly, this.source, args) };
    this.sendResponse(response);
  }

  /**
   * The scopes of ONE frame (C7). Locals, Value Stack and Variables describe the
   * selected frame — an outer frame reports the state at its own call
   * instruction, not the innermost frame's. Globals and the Ledger are VM-wide,
   * so every code frame offers them; a contract-boundary frame has no state of
   * its own and offers nothing.
   */
  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments,
  ): void {
    const frame = this.frameById(args.frameId);
    if (!frame || frame.kind === 'contract') {
      response.body = { scopes: [] };
      this.sendResponse(response);
      return;
    }
    const level = frame.level;
    const scopes: Scope[] = [
      new Scope('Locals', scopeRef(level, ScopeKind.Locals), false),
      new Scope('Value Stack', scopeRef(level, ScopeKind.Stack), false),
    ];
    // The source-level Variables scope is offered only when the resolver has
    // DWARF functions; without it the list is exactly [Locals, Value Stack].
    if (this.variables.hasVariables()) {
      scopes.unshift(new Scope('Variables', scopeRef(level, ScopeKind.SourceVars), false));
    }
    // G4: globals appear only for a trace whose records carry them.
    if (this.recordFor(frame)?.globals !== undefined) {
      scopes.push(new Scope('Globals', scopeRef(level, ScopeKind.Globals), false));
    }
    // L14: the ledger appears only for a trace carrying ledger information —
    // never as an empty tree.
    if (this.model?.ledger.hasLedger()) {
      scopes.push(new Scope('Ledger', scopeRef(level, ScopeKind.Ledger), false));
    }
    response.body = { scopes };
    this.sendResponse(response);
  }

  /** The frame a client-supplied frame id refers to, or undefined. */
  private frameById(frameId: number): CallFrame | undefined {
    return this.callFrames()[frameId - FRAME_ID_BASE];
  }

  /** The trace record whose runtime state a frame reports, if it has one. */
  private recordFor(frame: CallFrame): TraceRecord | undefined {
    return frame.stateIndex === null ? undefined : this.model?.records[frame.stateIndex];
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): void {
    const variables = this.nodesFor(args.variablesReference).map((n) =>
      this.toDapVariable(n.name, n.value),
    );
    response.body = { variables };
    this.sendResponse(response);
  }

  /**
   * The nodes behind a variables reference: a scope of some frame, or a container
   * previously handed out behind a child handle. Every scope — wasm locals, the
   * ledger tree, decoded Rust values — arrives as `ChildVar`s, so they all reach
   * DAP through `toDapVariable` and its lazy-children plumbing.
   */
  private nodesFor(reference: number): ChildVar[] {
    const scope = decodeScopeRef(reference);
    if (scope === null) {
      return this.expandChildHandle(reference);
    }
    const frame = this.callFrames()[scope.level];
    if (!frame) {
      return [];
    }
    const record = this.recordFor(frame);
    switch (scope.kind) {
      case ScopeKind.Locals:
        return record ? localNodes(record) : [];
      case ScopeKind.Stack:
        return record ? stackNodes(record) : [];
      case ScopeKind.Globals:
        return record ? globalNodes(record) : [];
      case ScopeKind.SourceVars:
        return this.sourceVarNodes(frame);
      case ScopeKind.Ledger:
        return this.ledgerScopeNodes();
      default:
        return [];
    }
  }

  /**
   * A frame's own DWARF variables, decoded against that frame's runtime state:
   * the register values the trace recorded where the frame stands (its own
   * instruction, or the call it is suspended in), and linear memory as it is NOW
   * — a callee may have written through a reference the caller still holds, and
   * the caller's spilled locals live in that memory.
   */
  private sourceVarNodes(frame: CallFrame): ChildVar[] {
    const record = this.recordFor(frame);
    const pc = frame.pc;
    if (!this.model || !record || pc === null) {
      return [];
    }
    const state = makeRuntimeState(record, this.model.memory, this.model.cursor);
    return frame.variables.map((v) => ({
      name: v.name ?? '<anon>',
      value: this.variables.decodeVariable(v, state, pc),
    }));
  }

  /**
   * The top-level nodes of the Ledger scope (docs/state-inspection.md,
   * Presentation), built by the shared ledger view.
   */
  private ledgerScopeNodes(): ChildVar[] {
    if (!this.model) {
      return [];
    }
    return ledgerNodes(ledgerSnapshot(this.model.ledger, this.model.cursor));
  }

  /** Expand a container handed out earlier by `toDapVariable`. */
  private expandChildHandle(reference: number): ChildVar[] {
    const children = this.childHandles.get(reference);
    if (!children) {
      return [];
    }
    try {
      return children();
    } catch {
      return [{ name: '<error>', value: { display: '<unreadable>' } }];
    }
  }

  /**
   * Render a decoded value as a DAP variable. Expandable values register their
   * lazy children behind a fresh handle; leaves report a zero reference.
   */
  private toDapVariable(name: string, decoded: DecodedValue): DebugProtocol.Variable {
    const variablesReference = decoded.children ? this.childHandles.create(decoded.children) : 0;
    return { name, value: decoded.display, type: decoded.typeName, variablesReference };
  }

  // --- Stepping ---------------------------------------------------------

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments,
  ): void {
    this.sendResponse(response);
    this.run('forward');
  }

  protected reverseContinueRequest(
    response: DebugProtocol.ReverseContinueResponse,
    _args: DebugProtocol.ReverseContinueArguments,
  ): void {
    this.sendResponse(response);
    this.run('backward');
  }

  protected nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments,
  ): void {
    this.sendResponse(response);
    // S5/S10: step over — the next stop point not in a deeper frame.
    this.step(args.granularity, (depth) => depth);
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments,
  ): void {
    this.sendResponse(response);
    // S4/S10: step in — the next stop point regardless of depth.
    this.step(args.granularity, () => Infinity);
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments,
  ): void {
    this.sendResponse(response);
    // S7: step out — the next stop point in a shallower frame; at the outermost
    // recorded depth this exhausts and terminates (S20) at statement
    // granularity, or clamps like S2 at instruction granularity.
    this.step(args.granularity, (depth) => depth - 1);
  }

  protected stepBackRequest(
    response: DebugProtocol.StepBackResponse,
    args: DebugProtocol.StepBackArguments,
  ): void {
    this.sendResponse(response);
    // S8/S10: reverse step over — the previous stop point not in a deeper frame.
    if (this.cursor) {
      this.cursor.stepBackward(granularityOf(args.granularity), this.cursor.depth);
      this.reportStop('step');
    }
  }

  /**
   * One forward step at the requested granularity, with the depth ceiling
   * derived from the cursor's current depth. A statement step off the end of the
   * trace terminates the session (S20) and must NOT also report a stop.
   */
  private step(
    granularity: DebugProtocol.SteppingGranularity | undefined,
    maxDepth: (depth: number) => number,
  ): void {
    if (!this.cursor) {
      return;
    }
    const outcome = this.cursor.stepForward(
      granularityOf(granularity),
      maxDepth(this.cursor.depth),
    );
    if (outcome === 'terminated') {
      this.sendEvent(new TerminatedEvent());
    } else {
      this.reportStop('step');
    }
  }

  /**
   * Report a stop. The cursor has moved, so everything derived from it is stale:
   * the call stack is dropped (rebuilt on the next `stackTrace`) and the child
   * handles are reset, which DAP already treats as invalidated at a stop.
   */
  private reportStop(reason: 'entry' | 'step' | 'breakpoint'): void {
    this.frames = undefined;
    this.childHandles.reset();
    this.sendEvent(new StoppedEvent(reason, THREAD_ID));
  }

  /** Run to the next/previous breakpoint, or clamp to the trace's last/first stop. */
  private run(direction: 'forward' | 'backward'): void {
    if (!this.cursor) {
      return;
    }
    const breakpoints = this.breakpointIndices();
    const outcome =
      direction === 'forward'
        ? this.cursor.runForward(breakpoints)
        : this.cursor.runBackward(breakpoints);
    this.reportStop(outcome === 'breakpoint' ? 'breakpoint' : 'step');
  }

  // --- Teardown ---------------------------------------------------------

  protected async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): Promise<void> {
    await this.teardown();
    this.sendResponse(response);
  }

  /**
   * Dispose the per-connection backend exactly once. This is the single place
   * `backend.dispose()` runs, reached both by the client's `disconnect` request
   * and by the TCP server's socket 'close'/'error' handlers (an abrupt
   * disconnect — editor crash, network drop, SIGKILL — sends no `disconnect`
   * over the wire, so without this the LiveBackend's komet-node subprocess would
   * leak). Public and idempotent: the `disposed` guard makes a second call after
   * a clean disconnect a no-op, so the komet-node pipeline is never
   * double-disposed. NOTE: `DebugSession.shutdown()` is a no-op in server mode,
   * so it can NOT be relied on for backend teardown — this must be called directly.
   */
  async teardown(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      // A launch may never have happened, in which case the backend is still a
      // selector function with nothing to dispose.
      if (typeof this.backend !== 'function') {
        await this.backend.dispose();
      }
    } catch {
      // best-effort teardown
    }
  }

  protected async terminateRequest(
    response: DebugProtocol.TerminateResponse,
    _args: DebugProtocol.TerminateArguments,
  ): Promise<void> {
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  private log(message: string): void {
    this.sendEvent(new OutputEvent(`${message}\n`, 'console'));
  }
}

/** DAP's stepping granularity in the engine's vocabulary; statement by default. */
function granularityOf(granularity: DebugProtocol.SteppingGranularity | undefined): Granularity {
  return granularity === 'instruction' ? 'instruction' : 'statement';
}
