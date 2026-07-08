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
