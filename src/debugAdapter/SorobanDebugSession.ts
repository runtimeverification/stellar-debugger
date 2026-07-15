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
import * as path from 'path';
import { TraceModel } from './TraceModel';
import {
  classifyLineRole,
  computeDepths,
  computeRunStarts,
  firstNonWhitespaceColumn,
  statementStops,
} from './stops';
import { SourceMapper } from '../sourcemap/SourceMapper';
import { VariableResolver, NullVariableResolver } from '../sourcemap/VariableResolver';
import { Disassembly } from '../wasm/Disassembly';
import { ResolvedTrace, SessionBackend, SorobanLaunchArgs } from './types';
import { TypedValue } from '../komet/trace';
import { renderInstr } from '../komet/mnemonics';
import { MemoryImage } from './MemoryImage';
import { makeRuntimeState } from './runtimeState';
import { DecodedValue, ChildVar } from '../dwarf/ValueDecoder';
import { ScopeVar } from '../dwarf/ScopeIndex';

const THREAD_ID = 1;
const FRAME_ID = 1;

/** Variable-reference handles for the two scopes we expose. */
enum ScopeRef {
  Locals = 1,
  Stack = 2,
  SourceVars = 3,
}

export class SorobanDebugSession extends DebugSession {
  private readonly backend: SessionBackend;
  private model?: TraceModel;
  private source?: SourceMapper;
  private disassembly?: Disassembly;
  /** Per-record validated code offsets, parallel to the trace records. */
  private positions: (number | null)[] = [];
  /**
   * Validated code offset → trace record indices, built from `positions` at
   * launch. This is deliberately NOT TraceModel.posToIndices: that map holds
   * raw `pos` values, which are ambiguous across sections (e.g. global
   * initializers), and must never trigger an instruction breakpoint.
   */
  private validatedPosToIndices = new Map<number, number[]>();
  /** Call depth per record (docs/stepping.md Model/depth), built at launch. */
  private depths: number[] = [];
  /** Instruction-granularity stop points: the visible record indices, sorted. */
  private visibleIndices: number[] = [];
  /**
   * Statement-granularity stop points: the line-run starts AFTER S17/S18
   * declaration/brace filtering. This is where statement stepping, the entry
   * stop, and the first/last-stop clamps come to rest.
   */
  private runStarts: number[] = [];
  /**
   * The RAW line-run starts (one index per line execution, pre-S17/S18). Used
   * only to narrow source breakpoints to a single index per run (S12/S13):
   * breakpoint resolution is unchanged by S17/S18, so a breakpoint on a
   * declaration/brace line whose statement stops are filtered out must still
   * fire at its raw run starts.
   */
  private rawRunStarts: number[] = [];

  /** Resolves when the client has finished configuring (e.g. breakpoints). */
  private configurationDone!: Promise<void>;
  private signalConfigurationDone!: () => void;

  /**
   * Source breakpoints as requested by the client, keyed by normalized file
   * path. Re-resolved to trace indices on every use (cheap) via the mapper.
   */
  private readonly sourceBreakpoints = new Map<string, DebugProtocol.SourceBreakpoint[]>();
  /** Instruction breakpoints as requested code offsets (verified or not). */
  private instructionBreakpointAddrs: number[] = [];
  /** Container handles for structured variable expansion. */
  private readonly variableHandles = new Handles<TypedValue[]>();
  /** Source-level variable resolver (Null until a DWARF-bearing wasm loads). */
  private variables: VariableResolver = new NullVariableResolver();
  /** Folded linear-memory view for decoding memory-backed source variables. */
  private memoryImage?: MemoryImage;
  /**
   * Handles for lazily-expanded source-variable children. High start avoids
   * colliding with the fixed ScopeRef range; reset on every stop so refs are
   * fresh per cursor position.
   */
  private readonly sourceVarChildren = new Handles<() => ChildVar[]>(1000);

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
    try {
      const resolved: ResolvedTrace = await this.backend.resolve(args, (msg) => this.log(msg));
      this.model = resolved.model;
      this.source = resolved.source;
      this.variables = resolved.variables;
      this.memoryImage = new MemoryImage(this.model.records);
      this.disassembly = resolved.disassembly;
      this.positions = resolved.positions;
      this.validatedPosToIndices = new Map();
      this.visibleIndices = [];
      this.positions.forEach((pos, i) => {
        if (pos !== null) {
          this.visibleIndices.push(i);
          const list = this.validatedPosToIndices.get(pos);
          if (list) {
            list.push(i);
          } else {
            this.validatedPosToIndices.set(pos, [i]);
          }
        }
      });
      const source = this.source;
      this.depths = computeDepths(this.model.records, this.positions, this.disassembly.functionRanges);
      this.rawRunStarts = computeRunStarts(this.positions, this.depths, (i) => source.lineKeyForIndex(i));
      this.runStarts = statementStops(this.rawRunStarts, this.depths, (i) =>
        classifyLineRole(source.sourceTextForIndex(i)),
      );

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
      // S1: the entry stop lands on the first stop point, never on the
      // invisible/unmapped records at the head of the trace.
      this.model.seek(this.firstStopPoint());
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

    const breakpoints: DebugProtocol.Breakpoint[] = this.instructionBreakpointAddrs.map((addr) => {
      const verified = this.validatedPosToIndices.has(addr);
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

  /**
   * Union of the trace indices all stored breakpoints resolve to. A source
   * breakpoint stops once per EXECUTION of its line (S12): the mapper's
   * per-record resolution is narrowed to the line-run starts, so forward and
   * reverse continue agree on one index per run (S13). Instruction breakpoints
   * stop on every record at their validated address (S15).
   */
  private resolvedBreakpointIndices(): Set<number> {
    const indices = new Set<number>();
    if (this.source) {
      // Narrow against the RAW run starts, not the S17/S18-filtered statement
      // stops: breakpoint resolution is unchanged by declaration/brace
      // filtering, so a breakpoint on a filtered line still fires once per run.
      const runStartSet = new Set(this.rawRunStarts);
      for (const [file, breakpoints] of this.sourceBreakpoints) {
        for (const bp of breakpoints) {
          const resolved = this.source.resolveBreakpoint(file, bp.line);
          for (const i of resolved?.indices ?? []) {
            if (runStartSet.has(i)) {
              indices.add(i);
            }
          }
        }
      }
    }
    for (const addr of this.instructionBreakpointAddrs) {
      for (const i of this.validatedPosToIndices.get(addr) ?? []) {
        indices.add(i);
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
    const rec = this.model.current;
    const frameName = `${renderInstr(rec.instr)}  [${this.model.cursor}/${this.model.length - 1}]`;

    // Unmapped records get no Source at all (and line 0): the client keeps
    // showing the frame name instead of opening a wrong file. S19: a mapped
    // frame reports the line's first non-whitespace column, not the arbitrary
    // DWARF sub-expression column; fall back to the DWARF column when the line
    // text is unavailable or all-whitespace.
    const frame: DebugProtocol.StackFrame = loc
      ? new StackFrame(
          FRAME_ID,
          frameName,
          new Source(path.basename(loc.path), loc.path),
          loc.line,
          firstNonWhitespaceColumn(this.source.sourceTextForIndex(this.model.cursor)) ?? loc.column ?? 0,
        )
      : new StackFrame(FRAME_ID, frameName);
    const reference = this.instructionPointerReference();
    if (reference !== undefined) {
      frame.instructionPointerReference = reference;
    }
    response.body = { stackFrames: [frame], totalFrames: 1 };
    this.sendResponse(response);
  }

  /**
   * The validated code offset of the current record as a hex address — or,
   * for records without one, of the NEAREST earlier record that has one, so
   * the Disassembly View stays anchored on the last real instruction. When no
   * earlier record qualifies either (e.g. the trace opens with unvalidated
   * global-initializer records) there is no address to report.
   */
  private instructionPointerReference(): string | undefined {
    if (!this.model) {
      return undefined;
    }
    for (let i = this.model.cursor; i >= 0; i--) {
      const pos = this.positions[i];
      if (pos !== null && pos !== undefined) {
        return formatAddress(pos);
      }
    }
    return undefined;
  }

  /**
   * The current record's validated code offset, or — when it has none — the
   * NEAREST earlier record that does, so in-scope variable lookup stays
   * anchored on the last real instruction. Null when no record qualifies.
   */
  private currentPc(): number | null {
    if (!this.model) {
      return null;
    }
    for (let i = this.model.cursor; i >= 0; i--) {
      const pos = this.positions[i];
      if (pos !== null && pos !== undefined) {
        return pos;
      }
    }
    return null;
  }

  protected disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments,
  ): void {
    const instructions = this.disassembly?.instructions ?? [];
    const base = parseAddress(args.memoryReference) + (args.offset ?? 0);
    const anchor = Math.max(0, this.disassembly?.indexForAddress(base) ?? 0);
    const start = anchor + (args.instructionOffset ?? 0);

    const rows: DebugProtocol.DisassembledInstruction[] = [];
    let previousPath: string | undefined;
    for (let i = start; i < start + args.instructionCount; i++) {
      if (i < 0 || i >= instructions.length) {
        rows.push({
          address: formatAddress(paddingAddress(i, i - start, instructions)),
          instruction: '(invalid)',
          presentationHint: 'invalid',
        });
        continue;
      }
      const instr = instructions[i];
      const row: DebugProtocol.DisassembledInstruction = {
        address: formatAddress(instr.address),
        instruction: instr.text,
      };
      if (instr.bytes !== undefined) {
        row.instructionBytes = [...instr.bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      }
      const loc = this.source?.locationForAddress(instr.address);
      if (loc) {
        row.line = loc.line;
        if (loc.column !== undefined) {
          row.column = loc.column;
        }
        // DAP lets `location` be omitted while the file is unchanged from the
        // previous row's; clients inherit it downward.
        if (loc.path !== previousPath) {
          row.location = new Source(path.basename(loc.path), loc.path);
          previousPath = loc.path;
        }
      }
      rows.push(row);
    }

    response.body = { instructions: rows };
    this.sendResponse(response);
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    _args: DebugProtocol.ScopesArguments,
  ): void {
    // Fresh child-expansion refs per stop: last cursor's handles are stale.
    this.sourceVarChildren.reset();
    const scopes: Scope[] = [
      new Scope('Locals', ScopeRef.Locals, false),
      new Scope('Value Stack', ScopeRef.Stack, false),
    ];
    // The source-level Variables scope is offered only when the resolver has
    // DWARF functions; without it the list is exactly [Locals, Value Stack].
    if (this.variables.hasVariables()) {
      scopes.unshift(new Scope('Variables', ScopeRef.SourceVars, false));
    }
    response.body = { scopes };
    this.sendResponse(response);
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): void {
    const variables: DebugProtocol.Variable[] = [];
    const rec = this.model?.current;

    if (args.variablesReference === ScopeRef.SourceVars) {
      // Source-level variables: resolve the in-scope DWARF variables at the
      // current PC and decode each against the folded runtime state.
      if (this.model && this.memoryImage) {
        const pc = this.currentPc();
        if (pc !== null) {
          const state = makeRuntimeState(this.model.current, this.memoryImage, this.model.cursor);
          for (const v of this.variables.variablesInScope(pc) as ScopeVar[]) {
            const decoded = this.variables.decodeVariable(v, state, pc);
            variables.push(this.toDapVariable(v.name ?? '<anon>', decoded));
          }
        }
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    const childThunk = this.sourceVarChildren.get(args.variablesReference);
    if (childThunk) {
      // A lazily-expanded source-variable container handed out via toDapVariable.
      try {
        for (const child of childThunk()) {
          variables.push(this.toDapVariable(child.name, child.value));
        }
      } catch {
        variables.push({ name: '<error>', value: '<unreadable>', variablesReference: 0 });
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

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
    args: DebugProtocol.NextArguments,
  ): void {
    this.sendResponse(response);
    // S5/S10: step over — the next stop point not in a deeper frame.
    this.stepForward(args.granularity, this.currentDepth());
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments,
  ): void {
    this.sendResponse(response);
    // S4/S10: step in — the next stop point regardless of depth.
    this.stepForward(args.granularity, Infinity);
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments,
  ): void {
    this.sendResponse(response);
    // S7: step out — the next stop point in a shallower frame; at the
    // outermost recorded depth this exhausts and terminates (S20) at statement
    // granularity, or clamps like S2 at instruction granularity.
    this.stepForward(args.granularity, this.currentDepth() - 1);
  }

  // --- Reverse stepping (time travel) ----------------------------------

  protected stepBackRequest(
    response: DebugProtocol.StepBackResponse,
    args: DebugProtocol.StepBackArguments,
  ): void {
    this.sendResponse(response);
    // S8/S10: reverse step over — the previous stop point not in a deeper
    // frame. Reverse steps always CLAMP to the first stop (S3/S8) and never
    // terminate; S20 is forward-only.
    this.stopAfter(() => this.moveCursorBackward(this.stopPoints(args.granularity), this.currentDepth()));
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
      // S14: no further breakpoint — settle on the LAST stop point, never on
      // the trace's trailing invisible/unmapped records.
      this.model.seek(this.lastStopPoint());
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
      // S14: no breakpoint behind — settle on the FIRST stop point.
      this.model.seek(this.firstStopPoint());
      this.sendEvent(new StoppedEvent('step', THREAD_ID));
    }
  }

  /** Apply a cursor move and emit a Stopped(step) event. */
  private stopAfter(move: () => void): void {
    move();
    this.sendEvent(new StoppedEvent('step', THREAD_ID));
  }

  /**
   * The stop points of the active granularity (docs/stepping.md): the line-run
   * starts for statement stepping, the visible records for instruction
   * stepping — also the fallback when no record maps to a source line.
   */
  private stopPoints(granularity: DebugProtocol.SteppingGranularity | undefined): readonly number[] {
    if (granularity !== 'instruction' && this.runStarts.length > 0) {
      return this.runStarts;
    }
    return this.visibleIndices;
  }

  /** Call depth of the record at the cursor. */
  private currentDepth(): number {
    return (this.model && this.depths[this.model.cursor]) ?? 0;
  }

  /**
   * Forward step (S2/S5/S7/S20): seek to the first stop point after the cursor
   * whose depth is <= `maxDepth`, then report a stop. With no such stop ahead,
   * a STATEMENT step (granularity !== 'instruction' over the source run-start
   * stop set) TERMINATES the session (S20) — the replayed contract has returned
   * from its outermost recorded frame — while an INSTRUCTION step, or a
   * wasm-less replay with no run starts, clamps to the last stop point and
   * reports a stop (S2). Emits its own event, so it is called directly (not via
   * stopAfter): a termination must NOT be followed by a StoppedEvent.
   */
  private stepForward(
    granularity: DebugProtocol.SteppingGranularity | undefined,
    maxDepth: number,
  ): void {
    if (!this.model) {
      return;
    }
    const points = this.stopPoints(granularity);
    const cursor = this.model.cursor;
    for (const i of points) {
      if (i > cursor && this.depths[i] <= maxDepth) {
        this.model.seek(i);
        this.sendEvent(new StoppedEvent('step', THREAD_ID));
        return;
      }
    }
    // Nothing qualifying ahead.
    if (granularity !== 'instruction' && this.runStarts.length > 0) {
      // S20: a forward source step past the last statement ends the session.
      this.sendEvent(new TerminatedEvent());
      return;
    }
    // S2: instruction granularity / wasm-less replay clamps to the last stop
    // point (staying put when already there) and still reports a stop.
    if (points.length > 0) {
      this.model.seek(points[points.length - 1]);
    }
    this.sendEvent(new StoppedEvent('step', THREAD_ID));
  }

  /**
   * Reverse step (S3/S8): move the cursor to the nearest earlier stop point
   * whose depth is <= `maxDepth`. With none behind, clamp to the first stop
   * point (staying put when already there). An empty stop-point list (trace
   * with no visible record at all) leaves the cursor where it is. Reverse steps
   * always clamp and never terminate.
   */
  private moveCursorBackward(points: readonly number[], maxDepth: number): void {
    if (!this.model || points.length === 0) {
      return;
    }
    const cursor = this.model.cursor;
    for (let k = points.length - 1; k >= 0; k--) {
      const i = points[k];
      if (i < cursor && this.depths[i] <= maxDepth) {
        this.model.seek(i);
        return;
      }
    }
    this.model.seek(points[0]);
  }

  /** The trace's first stop point: run start, else visible record, else 0. */
  private firstStopPoint(): number {
    return this.runStarts[0] ?? this.visibleIndices[0] ?? 0;
  }

  /** The trace's last stop point (counterpart of firstStopPoint). */
  private lastStopPoint(): number {
    return (
      this.runStarts[this.runStarts.length - 1] ??
      this.visibleIndices[this.visibleIndices.length - 1] ??
      Math.max(0, (this.model?.length ?? 1) - 1)
    );
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

  /**
   * Render a decoded source-level value as a DAP variable. Expandable values
   * register their lazy children behind a fresh `sourceVarChildren` handle;
   * leaves report a zero reference (not expandable).
   */
  private toDapVariable(name: string, decoded: DecodedValue): DebugProtocol.Variable {
    const variablesReference = decoded.children ? this.sourceVarChildren.create(decoded.children) : 0;
    return { name, value: decoded.display, type: decoded.typeName, variablesReference };
  }

  private log(message: string): void {
    this.sendEvent(new OutputEvent(`${message}\n`, 'console'));
  }
}

/** Hex form of a code offset; negatives (padding only) render as '-0x…'. */
function formatAddress(n: number): string {
  return n < 0 ? '-0x' + (-n).toString(16) : '0x' + n.toString(16);
}

/**
 * Numeric value of a client-supplied memory reference. Our own references are
 * always '0x…', which parseInt(ref, 16) accepts; anything unparseable or
 * negative clamps to 0.
 */
function parseAddress(reference: string): number {
  const n = parseInt(reference, 16);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

/**
 * Synthetic address for the padding row at out-of-range instruction index
 * `index`: counts down from the first instruction's address below the range
 * and up from the last one's above it, keeping every address in the response
 * unique and strictly increasing (VS Code keys rows by address). Below the
 * first instruction this can go negative — code offsets start near 0, so a
 * window scrolled above the top underflows; those rows are inert padding and
 * never real instructions. With no instructions at all, addresses are simply
 * the row index (0, 1, 2, …).
 */
function paddingAddress(
  index: number,
  rowIndex: number,
  instructions: readonly { address: number }[],
): number {
  if (instructions.length === 0) {
    return rowIndex;
  }
  if (index < 0) {
    return instructions[0].address + index;
  }
  return instructions[instructions.length - 1].address + (index - (instructions.length - 1));
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
