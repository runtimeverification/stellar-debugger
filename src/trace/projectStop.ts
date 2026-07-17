/**
 * A serializable projection of one trace stop (docs/interfaces.md,
 * "projectSourceStop"). Unlike the DAP handlers — whose lazy `Handles` /
 * child-thunk machinery is deliberately different — this reuses only the
 * low-level resolver calls and expands `DecodedValue.children` EAGERLY into
 * plain arrays, bounded by a per-stop depth/child/node budget.
 *
 * Pure module (no `vscode`, no DAP imports).
 */

import { ResolvedTrace } from '../debugAdapter/types';
import { StopModel, pcAtIndex } from '../debugAdapter/stopModel';
import { makeRuntimeState } from '../debugAdapter/runtimeState';
import { MemoryImage } from '../debugAdapter/MemoryImage';
import { renderInstr } from '../komet/mnemonics';
import { DecodedValue } from '../dwarf/ValueDecoder';

/** A serializable single-stop projection. */
export interface SourceStop {
  /** 0-based ordinal among source stops. */
  step: number;
  /** Index into model.records. */
  traceIndex: number;
  /** stopModel.depths[traceIndex]. */
  depth: number;
  /** Hex, e.g. "0x2d", or null. */
  pc: string | null;
  /** functionNameAt(pc), or null. */
  function: string | null;
  /** renderInstr(record.instr). */
  instr: string;
  /** Mapped source location, or null when unmapped. */
  source: { path: string; line: number; column?: number } | null;
  variables: TraceVar[];
}

/** One decoded variable, eagerly expanded within budget. */
export interface TraceVar {
  /** "<anon>" when DWARF gives none. */
  name: string;
  /** The type's display name; "" when the decoder supplies none. */
  type: string;
  value: string;
  /** Present only when expandable and within budget. */
  children?: TraceVar[];
  /** Marker set when the budget cut expansion. */
  truncated?: boolean;
}

/** Per-stop expansion budget plus an optional pre-built memory image. */
export interface ProjectOpts {
  maxDepth?: number;
  maxChildren?: number;
  maxNodes?: number;
  memory?: MemoryImage;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CHILDREN = 64;
const DEFAULT_MAX_NODES = 1500;

/** Mutable per-call node counter so a per-stop budget stays isolated. */
interface NodeCounter {
  count: number;
}

/**
 * Expand a decoded value into a serializable TraceVar, materializing children
 * eagerly up to the depth/child/node budget.
 */
function expandDecoded(
  name: string,
  decoded: DecodedValue,
  depth: number,
  maxDepth: number,
  maxChildren: number,
  maxNodes: number,
  counter: NodeCounter,
): TraceVar {
  const node: TraceVar = { name, type: decoded.typeName ?? '', value: decoded.display };

  if (typeof decoded.children === 'function') {
    if (depth >= maxDepth || counter.count >= maxNodes) {
      node.truncated = true;
      return node;
    }
    const rawChildren = decoded.children();
    if (rawChildren.length === 0) {
      // Genuinely empty — omit the `children` key entirely.
      return node;
    }
    const children: TraceVar[] = [];
    const limit = Math.min(rawChildren.length, maxChildren);
    for (let i = 0; i < limit; i++) {
      counter.count++;
      const child = rawChildren[i];
      children.push(
        expandDecoded(
          child.name,
          child.value,
          depth + 1,
          maxDepth,
          maxChildren,
          maxNodes,
          counter,
        ),
      );
    }
    if (rawChildren.length > maxChildren) {
      children.push({ name: '…', type: '', value: '…', truncated: true });
    }
    node.children = children;
  }

  return node;
}

/**
 * Project the stop at `index` into a serializable `SourceStop`, reusing the
 * low-level resolver calls and eagerly expanding decoded variable trees.
 */
export function projectSourceStop(
  resolved: ResolvedTrace,
  stopModel: StopModel,
  index: number,
  opts?: ProjectOpts,
): SourceStop {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxChildren = opts?.maxChildren ?? DEFAULT_MAX_CHILDREN;
  const maxNodes = opts?.maxNodes ?? DEFAULT_MAX_NODES;

  const record = resolved.model.records[index];

  const mapped = resolved.source.locationForIndex(index);
  let source: SourceStop['source'] = null;
  if (mapped) {
    source = { path: mapped.path, line: mapped.line };
    if (mapped.column !== undefined && mapped.column !== null) {
      source.column = mapped.column;
    }
  }

  const pc = pcAtIndex(resolved.positions, index);
  const pcHex = pc === null ? null : '0x' + pc.toString(16);
  const functionName = pc === null ? null : (resolved.variables.functionNameAt(pc) ?? null);

  const variables: TraceVar[] = [];
  if (pc !== null && resolved.variables.hasVariables()) {
    const memory = opts?.memory ?? new MemoryImage(resolved.model.records);
    const state = makeRuntimeState(record, memory, index);
    const counter: NodeCounter = { count: 0 };
    for (const v of resolved.variables.variablesInScope(pc)) {
      const decoded = resolved.variables.decodeVariable(v, state, pc);
      variables.push(
        expandDecoded(v.name ?? '<anon>', decoded, 0, maxDepth, maxChildren, maxNodes, counter),
      );
    }
  }

  const step = stopModel.runStarts.indexOf(index);

  return {
    step,
    traceIndex: index,
    depth: stopModel.depths[index],
    pc: pcHex,
    function: functionName,
    instr: renderInstr(record.instr),
    source,
    variables,
  };
}
