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

import { TraceRecord, opcode } from '../komet/trace';

/** A function body in code-offset space: [start, end). */
export interface FunctionRange {
  start: number;
  end: number;
}

/** Opcodes that descend into a callee (may increase call depth). */
const CALL_OPCODES = new Set(['call', 'call_indirect', 'return_call', 'return_call_indirect']);
/** Opcodes that return from the current callee (decrease call depth). */
const RETURN_OPCODES = new Set(['return']);

/**
 * Fallback call-depth reconstruction from call/return opcodes alone (used when
 * no function-body ranges exist, i.e. wasm-less replay). Depth is recorded at
 * instruction entry, so a `return` belongs to the frame it leaves. Implicit
 * returns are invisible to this walk — see computeDepths.
 */
export function opcodeDepths(records: readonly TraceRecord[]): number[] {
  const depths = new Array<number>(records.length);
  let depth = 0;
  for (let i = 0; i < records.length; i++) {
    depths[i] = depth;
    const op = opcode(records[i]);
    if (CALL_OPCODES.has(op)) {
      depth++;
    } else if (RETURN_OPCODES.has(op) && depth > 0) {
      depth--;
    }
  }
  return depths;
}

/**
 * Call depth per trace record (spec Model/depth).
 *
 * With function-body ranges, depth follows a frame stack over the VISIBLE
 * records (validated `positions[i] !== null`): moving into a different
 * function's body right after a call-class record pushes a frame; any other
 * transition pops back to that function's frame (matching implicit returns,
 * which produce no record) or, when the function is not on the stack at all,
 * replaces the current frame. Invisible records carry the depth of the
 * surrounding visible context. Without ranges (or with an empty list) the
 * opcode-based reconstruction is the fallback.
 */
export function computeDepths(
  records: readonly TraceRecord[],
  positions: readonly (number | null)[],
  functionRanges?: readonly FunctionRange[],
): number[] {
  if (!functionRanges || functionRanges.length === 0) {
    return opcodeDepths(records);
  }
  const ranges = [...functionRanges].sort((a, b) => a.start - b.start);

  const depths = new Array<number>(records.length);
  /** Frame stack of function identities (range indices; -1 = outside all bodies). */
  const stack: number[] = [];
  let prevVisible = -1;
  for (let i = 0; i < records.length; i++) {
    const pos = positions[i] ?? null;
    if (pos === null) {
      depths[i] = Math.max(0, stack.length - 1);
      continue;
    }
    const fn = functionIndexAt(ranges, pos);
    if (stack.length === 0) {
      stack.push(fn);
    } else if (fn !== stack[stack.length - 1]) {
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
        stack.push(fn);
      } else {
        const frame = stack.lastIndexOf(fn);
        if (frame >= 0) {
          stack.length = frame + 1;
        } else {
          stack[stack.length - 1] = fn;
        }
      }
    }
    depths[i] = stack.length - 1;
    prevVisible = i;
  }
  return depths;
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
