/**
 * The pure stop-point model behind predictable stepping (docs/stepping.md):
 * per-record call depths and line-run starts, from which the debug adapter
 * derives every stepping, continue, and breakpoint decision.
 *
 * Depth cannot be reconstructed from call/return opcodes alone — komet-node
 * emits NO record for implicit returns (a callee falling off its end), so an
 * opcode walk only ever climbs. With a disassembly's function-body ranges the
 * depth instead follows the function membership of consecutive visible
 * records; the opcode walk remains the documented fallback for wasm-less
 * replay.
 *
 * Pure module (no `vscode` / DAP imports) so the model is unit-testable.
 */

import * as path from 'path';

import { TraceRecord, opcode } from '../komet/trace';

/**
 * A function body in code-offset space: [start, end). Call-depth reconstruction
 * reads only the bounds; `index` and `name` are what a wasm-level call stack
 * frame is labelled with (docs/callstack.md, C4) and are absent for a
 * trace-derived disassembly, which knows no function structure at all.
 */
export interface FunctionRange {
  start: number;
  end: number;
  /** Wasm function index (imports included in the numbering). */
  index?: number;
  /** Demangled name from the module's `name` section, when it has one. */
  name?: string;
}

/** Opcodes that descend into a callee (may increase call depth). */
const CALL_OPCODES = new Set(['call', 'call_indirect', 'return_call', 'return_call_indirect']);
/** Opcodes that return from the current callee (decrease call depth). */
const RETURN_OPCODES = new Set(['return']);

/**
 * One activation record of the reconstructed wasm frame stack — the physical
 * call stack the debugger shows (docs/callstack.md, C1) and the same structure
 * the stepping depth is read off (`computeDepths`), so the Callstack view and
 * step-over/step-out can never disagree about what a frame is.
 *
 * Frames are IMMUTABLE and SHARED: the walk hands the same object to every
 * record executing in that activation, and `caller` links it to the frame it
 * returns into, so the whole trace's stacks cost one object per call.
 */
export interface WasmFrame {
  /** Index into the sorted function ranges; -1 when the pc is in no known body. */
  fn: number;
  /** Call depth, 0 = outermost. Equals `computeDepths()[i]` for this frame's records. */
  depth: number;
  /**
   * Record index of the `call` that created this frame — i.e. the CALLER's
   * position while this frame runs, which is what an outer stack frame reports.
   * Null for the outermost frame and wherever the walk lost the call site.
   */
  callSite: number | null;
  /** The frame this one returns into, or null at the outermost. */
  caller: WasmFrame | null;
}

/** The per-record frame stacks of a trace, plus the ranges the walk indexed. */
export interface FrameStacks {
  /**
   * Innermost frame per record (parallel to `records`); null only for records
   * ahead of the first frame the walk could establish.
   */
  frames: (WasmFrame | null)[];
  /** The function ranges `WasmFrame.fn` indexes, sorted by start; empty in the opcode fallback. */
  ranges: readonly FunctionRange[];
}

/**
 * Fallback frame reconstruction from call/return opcodes alone (used when no
 * function-body ranges exist, i.e. wasm-less replay). Depth is recorded at
 * instruction entry, so a `return` belongs to the frame it leaves. Implicit
 * returns are invisible to this walk — see computeFrames. Frames carry no
 * function identity here (`fn: -1`): without ranges there is nothing to name.
 */
function opcodeFrames(records: readonly TraceRecord[]): (WasmFrame | null)[] {
  const frames = new Array<WasmFrame | null>(records.length);
  let frame: WasmFrame = { fn: -1, depth: 0, callSite: null, caller: null };
  for (let i = 0; i < records.length; i++) {
    frames[i] = frame;
    const op = opcode(records[i]);
    if (CALL_OPCODES.has(op)) {
      frame = { fn: -1, depth: frame.depth + 1, callSite: i, caller: frame };
    } else if (RETURN_OPCODES.has(op) && frame.caller !== null) {
      frame = frame.caller;
    }
  }
  return frames;
}

/**
 * Fallback call-depth reconstruction from call/return opcodes alone; see
 * `opcodeFrames`, of which this is the depth projection.
 */
export function opcodeDepths(records: readonly TraceRecord[]): number[] {
  return opcodeFrames(records).map((frame) => frame?.depth ?? 0);
}

/**
 * The wasm frame stack per trace record (spec Model/depth, docs/callstack.md C1).
 *
 * With function-body ranges, the stack follows the function membership of the
 * VISIBLE records (validated `positions[i] !== null`): moving into a different
 * function's body right after a call-class record pushes a frame; any other
 * transition pops back to that function's frame (matching implicit returns,
 * which produce no record) or, when the function is not on the stack at all,
 * replaces the current frame. Invisible records carry the frame of the
 * surrounding visible context. Without ranges (or with an empty list) the
 * opcode-based reconstruction is the fallback.
 */
export function computeFrames(
  records: readonly TraceRecord[],
  positions: readonly (number | null)[],
  functionRanges?: readonly FunctionRange[],
): FrameStacks {
  if (!functionRanges || functionRanges.length === 0) {
    return { frames: opcodeFrames(records), ranges: [] };
  }
  const ranges = [...functionRanges].sort((a, b) => a.start - b.start);

  const frames = new Array<WasmFrame | null>(records.length);
  /** Frame stack, outermost first; the last entry is the executing frame. */
  const stack: WasmFrame[] = [];
  let prevVisible = -1;
  for (let i = 0; i < records.length; i++) {
    const pos = positions[i] ?? null;
    if (pos === null) {
      frames[i] = stack[stack.length - 1] ?? null;
      continue;
    }
    const fn = functionIndexAt(ranges, pos);
    const top = stack[stack.length - 1];
    if (top === undefined) {
      stack.push({ fn, depth: 0, callSite: null, caller: null });
    } else if (fn !== top.fn) {
      // A genuine call ENTRY lands on the callee body's first instruction right
      // after a call-class record; a return lands just after the caller's call
      // (never on a body's first instruction), so a call record alone does not
      // imply entry — the returning callee's last visible instruction is often
      // itself a call (e.g. a tail host import). Distinguishing them keeps an
      // implicit return from inflating the stack forever (defect I1).
      const isEntry =
        fn >= 0 &&
        pos === ranges[fn].start &&
        prevVisible >= 0 &&
        CALL_OPCODES.has(opcode(records[prevVisible]));
      if (isEntry) {
        stack.push({ fn, depth: stack.length, callSite: prevVisible, caller: top });
      } else {
        const frame = lastIndexOfFn(stack, fn);
        if (frame >= 0) {
          stack.length = frame + 1;
        } else {
          // Execution surfaced in a function that is not on the stack at all:
          // the identity changes but the activation (and its depth) does not.
          stack[stack.length - 1] = { ...top, fn };
        }
      }
    }
    frames[i] = stack[stack.length - 1];
    prevVisible = i;
  }
  return { frames, ranges };
}

/** Topmost stack position holding function identity `fn`, or -1. */
function lastIndexOfFn(stack: readonly WasmFrame[], fn: number): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].fn === fn) {
      return i;
    }
  }
  return -1;
}

/**
 * Call depth per trace record (spec Model/depth) — the depth projection of
 * `computeFrames`, which is where the reconstruction itself is documented.
 */
export function computeDepths(
  records: readonly TraceRecord[],
  positions: readonly (number | null)[],
  functionRanges?: readonly FunctionRange[],
): number[] {
  return computeFrames(records, positions, functionRanges).frames.map(
    (frame) => frame?.depth ?? 0,
  );
}

/**
 * The syntactic role of a source line, used to filter statement-granularity
 * stop points (S17/S18). Classification is purely textual — it never touches
 * the trace — so it is trivially unit-testable and independent of any mapper.
 */
export type LineRole = 'attribute' | 'signature' | 'brace' | 'statement';

/** `fn` item header with any leading pub/const/async/unsafe/extern qualifiers. */
const SIGNATURE_RE =
  /^(pub(\s*\([^)]*\))?\s+)?(const\s+|async\s+|unsafe\s+|extern(\s+"[^"]*")?\s+)*fn\b/;
/** `impl` / `trait` / `mod` item headers. */
const ITEM_RE = /^(impl|trait|mod)\b/;
/** Attribute lines: `#[...]` and inner `#![...]` (includes the export shim). */
const ATTRIBUTE_RE = /^#!?\[/;
/** A bare block-closing brace, optionally followed by `,` or `;`. */
const BRACE_RE = /^}[,;]?$/;

/**
 * Classify a raw source line by its role (S17/S18). A null line (no source
 * text available) is treated as a plain statement — never filtered — so a
 * missing source file can never suppress a stop.
 */
export function classifyLineRole(text: string | null): LineRole {
  if (text === null) {
    return 'statement';
  }
  const trimmed = text.trim();
  if (ATTRIBUTE_RE.test(trimmed)) {
    return 'attribute';
  }
  if (SIGNATURE_RE.test(trimmed) || ITEM_RE.test(trimmed)) {
    return 'signature';
  }
  if (BRACE_RE.test(trimmed)) {
    return 'brace';
  }
  return 'statement';
}

/**
 * Filter raw run starts down to statement-granularity stop points (S17/S18).
 *
 * Attribute lines (the `#[contractimpl]` export shim) are always glue and
 * dropped. A `fn`/`impl`/`trait`/`mod` signature is dropped unless it is its
 * frame's sole run start (a fully collapsed one-line function still needs a
 * step-in target). A closing brace is dropped unless it is the function's
 * final brace — the epilogue the return is attributed to. If filtering would
 * remove every stop, the unfiltered run starts stand (preserving S1/S2/S3).
 */
export function statementStops(
  runStarts: readonly number[],
  depths: readonly number[],
  roleAt: (index: number) => LineRole,
): number[] {
  /** A brace run start is kept iff it is the frame's final brace (S18). */
  const keepBrace = (p: number): boolean => {
    const d = depths[runStarts[p]];
    return p === runStarts.length - 1 || depths[runStarts[p + 1]] < d;
  };
  /** Whether a run start at position q is itself a kept (surviving) stop. */
  const isKeptStop = (q: number): boolean => {
    const r = roleAt(runStarts[q]);
    return r === 'statement' || (r === 'brace' && keepBrace(q));
  };
  /**
   * Whether this frame holds another kept stop at the SAME depth — scanning
   * both directions and stopping at the frame boundary (a run start shallower
   * than d, i.e. the caller). A signature is kept only when it is the sole run
   * start of its frame (S17 exception), which is a bidirectional property: an
   * epilogue signature that trails an earlier same-depth body statement must
   * still be dropped, so a forward-only look-ahead is not enough.
   */
  const otherSameDepthStopInFrame = (p: number): boolean => {
    const d = depths[runStarts[p]];
    for (let q = p + 1; q < runStarts.length; q++) {
      const dq = depths[runStarts[q]];
      if (dq < d) {
        break; // frame returned to the caller
      }
      if (dq === d && isKeptStop(q)) {
        return true;
      }
    }
    for (let q = p - 1; q >= 0; q--) {
      const dq = depths[runStarts[q]];
      if (dq < d) {
        break; // frame began after the caller
      }
      if (dq === d && isKeptStop(q)) {
        return true;
      }
    }
    return false;
  };

  const result: number[] = [];
  for (let p = 0; p < runStarts.length; p++) {
    const i = runStarts[p];
    const r = roleAt(i);
    if (r === 'attribute') {
      continue;
    } else if (r === 'statement') {
      result.push(i);
    } else if (r === 'brace') {
      if (keepBrace(p)) {
        result.push(i);
      }
    } else if (r === 'signature') {
      if (!otherSameDepthStopInFrame(p)) {
        result.push(i);
      }
    }
  }
  if (result.length === 0 && runStarts.length > 0) {
    return [...runStarts];
  }
  return result;
}

/**
 * The 1-based column of the first non-whitespace character of a source line
 * (S19). Returns null when the text is null or entirely whitespace, so the
 * caller can fall back to the DWARF column. This is what a statement stop's
 * stack frame reports instead of the arbitrary DWARF sub-expression column.
 */
export function firstNonWhitespaceColumn(text: string | null): number | null {
  if (text === null) {
    return null;
  }
  for (let i = 0; i < text.length; i++) {
    if (!/\s/.test(text[i])) {
      return i + 1;
    }
  }
  return null;
}

/** Normalized-path substrings that mark a NON-workspace (toolchain) source (S21). */
const NON_WORKSPACE_MARKERS = ['/.rustup/', '/.cargo/', '/rustc/'];

/**
 * Whether a mapped source path is the user's own workspace code (S21). A null
 * path (source unknown) counts as my-code so it is never over-filtered. A path
 * is non-workspace iff its normalized form contains any of `/.rustup/`,
 * `/.cargo/`, or `/rustc/` — the Rust toolchain std/core and crates.io
 * dependency source locations.
 */
export function isWorkspaceSource(path_: string | null): boolean {
  if (path_ === null) {
    return true;
  }
  const normalized = path.normalize(path_).replace(/\\/g, '/');
  return !NON_WORKSPACE_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Filter statement-granularity run starts to just the user's own code (S21):
 * keep each run start whose mapped source (via `pathAt`) is workspace, in order.
 * Obeys the same non-emptiness safety as S17/S18 — if every run start is
 * non-workspace, the unfiltered run starts stand (returned as a NEW array), so
 * a purely-library trace is still steppable.
 */
export function myCodeStops(
  runStarts: readonly number[],
  pathAt: (index: number) => string | null,
): number[] {
  const result = runStarts.filter((i) => isWorkspaceSource(pathAt(i)));
  if (result.length === 0 && runStarts.length > 0) {
    return [...runStarts];
  }
  return result;
}

/** Index of the sorted range containing `pos`, or -1 when outside all of them. */
function functionIndexAt(ranges: readonly FunctionRange[], pos: number): number {
  let lo = 0;
  let hi = ranges.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].start <= pos) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return candidate >= 0 && pos < ranges[candidate].end ? candidate : -1;
}

/**
 * Sorted indices of the line-run starts (spec Model/run) — the statement-
 * granularity stop points. Scanning the visible records in order, a mapped
 * record starts a new run iff its line key differs from its depth's current
 * run, its depth's run was abandoned (execution returned to a shallower frame
 * in between), or it RE-EXECUTES a code offset that run has already covered (a
 * loop back-edge landed inside it). A same-key record at a new offset merely
 * extends the run; invisible records, unmapped visible records, and whole
 * deeper frames are glue inside the enclosing run.
 */
export function computeRunStarts(
  positions: readonly (number | null)[],
  depths: readonly number[],
  lineKey: (index: number) => string | null,
): number[] {
  interface Run {
    key: string;
    offsets: Set<number>;
  }
  const starts: number[] = [];
  /** Current run per depth; entries above the cursor's depth die on return. */
  const runs: (Run | undefined)[] = [];
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    if (pos === null) {
      continue;
    }
    const key = lineKey(i);
    if (key === null) {
      continue;
    }
    const depth = depths[i];
    runs.length = depth + 1;
    const run = runs[depth];
    if (run && run.key === key && !run.offsets.has(pos)) {
      run.offsets.add(pos);
    } else {
      runs[depth] = { key, offsets: new Set([pos]) };
      starts.push(i);
    }
  }
  return starts;
}
