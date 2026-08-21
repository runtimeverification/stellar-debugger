/**
 * The call stack at a replay position (docs/callstack.md) — the shared headless
 * derivation behind the IDE's Callstack view and the CLI's `frames` projection,
 * so the two can never disagree about who called whom.
 *
 * The stack is assembled from three sources, in order of how much they can be
 * trusted, and each frame states which one it came from:
 *
 *   1. **wasm activations** (`WasmFrame`, `stops.ts`) — the physical frame stack
 *      reconstructed from the trace itself. This is ground truth at every
 *      optimization level and is the same structure stepping derives depth from,
 *      so the Callstack view and step-over/step-out always agree.
 *   2. **DWARF inlined subroutines** — the Rust frames an optimizing compiler
 *      erased from the activation stack. Inserted ABOVE the activation they were
 *      inlined into, they are why an optimized build still shows a Rust call
 *      chain instead of one wrapper function.
 *   3. **contract-call boundaries** (`LedgerImage`) — the host-level invocations
 *      the trace records. They sit BELOW everything else as non-code labels,
 *      naming the contract and function the wasm frames are running for.
 *
 * The naming ladder (C4) is likewise ordered by precision: a DWARF name, else
 * the module's demangled `name`-section symbol, else the wasm function index,
 * else the raw code offset. A frame is therefore never nameless, and never named
 * with something less precise than the build made available.
 *
 * Pure module (no `vscode` / DAP imports).
 */

import { MappedLocation } from '../sourcemap/SourceMapper';
import { ScopeVar } from '../dwarf/ScopeIndex';
import { InlineFrame } from '../sourcemap/VariableResolver';
import { FunctionRange, WasmFrame, isWorkspaceSource } from './stops';
import { LedgerCallFrame } from './LedgerImage';
import { ResolvedTrace } from './types';
import { renderAddress } from '../soroban/scvalJson';
import { pcAtIndex } from './stopModel';

/** Where a frame's identity came from — the rung of the ladder that named it. */
export type FrameKind =
  /** A wasm activation named and located by DWARF. */
  | 'rust'
  /** A Rust frame that optimization inlined into the activation below it. */
  | 'inline'
  /** A wasm activation with no source-level identity (no DWARF, or none at its pc). */
  | 'wasm'
  /** A host-level contract invocation: a boundary marker, not a code position. */
  | 'contract';

/** One frame of the call stack at a replay position. */
export interface CallFrame {
  /** 0 = innermost (where the cursor is), increasing outward. */
  level: number;
  /** Display name; never empty (C4). */
  name: string;
  kind: FrameKind;
  /**
   * The record whose runtime state this frame's variables are read from: the
   * cursor for the innermost activation, the frame's own call instruction for an
   * outer one. Null for a contract frame, which has no wasm state of its own.
   */
  stateIndex: number | null;
  /** Code offset this frame is executing at, or null when unknown. */
  pc: number | null;
  /** Where to open the editor for this frame, or null when unmapped. */
  source: MappedLocation | null;
  /**
   * True for a frame the user did not write — toolchain or dependency source
   * (S21's workspace test), and any frame with no source at all in a session
   * that HAS line info. Presented deemphasized rather than hidden (C5).
   */
  subtle: boolean;
  /** The DWARF variables this frame declares, in scope at its pc (C7). */
  variables: ScopeVar[];
}

/** Everything `buildCallStack` reads; a subset of `ResolvedTrace` plus the cursor. */
export interface CallStackInput {
  resolved: ResolvedTrace;
  /** Per-record wasm frame stacks, from `computeFrames`. */
  frames: readonly (WasmFrame | null)[];
  /** The function ranges `WasmFrame.fn` indexes (sorted), from `computeFrames`. */
  ranges: readonly FunctionRange[];
}

/**
 * The call stack at trace index `index`, innermost frame first.
 *
 * Never empty for a non-empty trace: with no activation, no DWARF and no
 * contract boundary to go on, the result is the single wasm frame at the
 * cursor's own address — the honest floor of the ladder.
 */
export function buildCallStack(input: CallStackInput, index: number): CallFrame[] {
  const { resolved, frames, ranges } = input;
  const hasLineInfo = resolved.source.hasLineInfo();
  const built: CallFrame[] = [];

  /** Push one frame, numbering it and deriving its deemphasis (C5). */
  const push = (frame: Omit<CallFrame, 'level' | 'subtle'>): void => {
    const subtle =
      frame.kind !== 'contract' &&
      (frame.source === null ? hasLineInfo : !isWorkspaceSource(frame.source.path));
    built.push({ ...frame, level: built.length, subtle });
  };

  /** An inlined call site put through the mapper's on-disk policy. */
  const callSiteLocation = (inline: InlineFrame): MappedLocation | null => {
    const site = inline.callSite;
    return site === undefined
      ? null
      : resolved.source.locationForFile(site.path, site.line, site.column);
  };

  /**
   * Expand one wasm activation into frames: the DWARF frames inlined into it
   * (innermost first) followed by the activation itself, positioned at record
   * `at`.
   */
  const pushActivation = (frame: WasmFrame | null, at: number): void => {
    const pc = pcAtIndex(resolved.positions, at);
    const range = frame && frame.fn >= 0 ? ranges[frame.fn] : undefined;
    const inlines = pc === null ? [] : resolved.variables.inlineFramesAt(pc);

    // An inlined chain shifts locations by one: the innermost frame stands where
    // the line table points, and every frame below it stands at the call site of
    // the frame above (C2). `inlines` is outermost first, so walk it backwards.
    let below: MappedLocation | null = resolved.source.locationForIndex(at);
    for (let i = inlines.length - 1; i >= 0; i--) {
      const inline = inlines[i];
      push({
        name: inline.name ?? '<inlined>',
        kind: 'inline',
        stateIndex: at,
        pc,
        source: below,
        variables: inline.variables,
      });
      below = callSiteLocation(inline);
    }

    const qualified = pc === null ? null : resolved.variables.qualifiedFunctionNameAt(pc);
    push({
      name: activationName(qualified, range, pc, below),
      // Source, not the name, decides the kind: rustc leaves some method DIEs
      // anonymous, and such a frame is still a located Rust frame — it just
      // borrows its label from the `name` section.
      kind: below === null ? 'wasm' : 'rust',
      stateIndex: at,
      pc,
      source: below,
      variables: pc === null ? [] : resolved.variables.variablesInScope(pc),
    });
  };

  // The activation stack, innermost first. The position walks outward with it: an
  // outer activation stands at the call instruction that entered the frame below
  // it, which is also where its own locals were last observed. Only the
  // outermost frame has no call site, so the walk cannot end early.
  let activation = frames[index] ?? null;
  let at: number | null = index;
  while (activation !== null && at !== null) {
    pushActivation(activation, at);
    at = activation.callSite;
    activation = activation.caller;
  }
  if (built.length === 0) {
    // No reconstructed activation at all: still report where the cursor is.
    pushActivation(null, index);
  }

  // Contract boundaries below the wasm frames, innermost call first.
  const ledger = resolved.model.ledger;
  if (ledger.hasLedger()) {
    for (const call of ledger.callStackAt(index)) {
      push({
        name: contractFrameName(call),
        kind: 'contract',
        stateIndex: null,
        pc: null,
        source: null,
        variables: [],
      });
    }
  }
  return built;
}

/**
 * A wasm activation's label, down the naming ladder (C4). A frame with no source
 * location carries its code offset — for a wasm-level session that offset is the
 * only position the user has, and inside a named function it is stated relative
 * to the function's start, the way a disassembler does.
 */
function activationName(
  qualified: string | null,
  range: FunctionRange | undefined,
  pc: number | null,
  source: MappedLocation | null,
): string {
  const indexed = range?.index === undefined ? null : `func[${range.index}]`;
  const name = qualified ?? range?.name ?? indexed;
  if (name === null) {
    return pc === null ? '<synthetic>' : `wasm@${hex(pc)}`;
  }
  if (source !== null || pc === null || range === undefined) {
    return name;
  }
  return pc === range.start ? name : `${name}+${hex(pc - range.start)}`;
}

/**
 * A contract invocation as a boundary label: `increment() @ CA5XKA…7QFM`. The
 * `C…` strkey is elided in the middle — a frame label has to stay readable in a
 * narrow panel, and the Ledger scope is where the full address is shown.
 */
function contractFrameName(call: LedgerCallFrame): string {
  return `${call.function}() @ ${shortAddress(renderAddress(call.to))}`;
}

/** Head and tail of an address long enough to need eliding. */
function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}
