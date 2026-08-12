/**
 * Normalization of a `soroban` launch configuration into a canonical,
 * ordered transaction sequence.
 *
 * A launch config carries an explicit `transactions` array (deploy / invoke
 * steps) plus a `trace` selector naming which submitted tx feeds the session.
 *
 * `normalizeConfig` folds it into one canonical `{ steps, trace }` shape: an
 * ordered `TxStep[]` and a `trace` RESOLVED to a 0-based index into it. It
 * validates handle references, deploy-id uniqueness and the trace selector,
 * throwing on any inconsistency.
 *
 * This is a PURE function: no filesystem, no network, no mutation of its input.
 * It performs NO wasm loading and NO arg encoding — invoke `args` are carried
 * through untouched, for `soroban/specEncode` to encode against the deployed
 * contract's own spec once the sequence runs.
 */

/** A deploy step: upload + create, registering a handle `id -> contractId`. */
export interface DeployStep {
  kind: 'deploy';
  /** Handle id later invoke steps reference via their `contract` field. */
  id: string;
  /** Path to a prebuilt `.wasm`. */
  wasm?: string;
  /** Path to a contract crate dir to build. */
  contract?: string;
  /** Build command for a `contract`-dir build (default `stellar contract build`). */
  buildCommand?: string;
  /** Build with DWARF debug info (default true) for a `contract`-dir build. */
  debugInfo?: boolean;
}

/** An invoke step: call `function` on the contract behind handle `contract`. */
export interface InvokeStep {
  kind: 'invoke';
  /** Handle id of a prior deploy step (NOT yet a live contractId). */
  contract: string;
  /** Function name to invoke. */
  function: string;
  /**
   * OPTIONAL label for this invoke. A `trace` string selector may name it to
   * pick this invoke's tx as the traced one (in addition to deploy ids).
   */
  id?: string;
  /**
   * Arguments as authored: an object keyed by the spec's parameter names. Carried
   * through verbatim — `soroban/specEncode` encodes them against the deployed
   * contract's own spec, which this module has no access to.
   */
  args?: unknown;
}

export type TxStep = DeployStep | InvokeStep;

/**
 * A trace selector as authored: `"last"` (default), a 0-based integer index,
 * or a transaction id string. `normalizeConfig` resolves it to a number.
 */
export type TraceSelector = 'last' | number | string;

/** The canonical, validated result of normalizing a launch configuration. */
export interface NormalizedConfig {
  steps: TxStep[];
  /** The traced tx's 0-based position in `steps`. */
  trace: number;
}

/**
 * Raw config as authored: a `transactions` array plus a `trace` selector.
 * Fully optional/loose: `normalizeConfig` validates it.
 */
export interface RawLaunchConfig {
  transactions?: unknown[];
  trace?: TraceSelector;
}

/**
 * Fold a raw launch config into the canonical `{ steps, trace }` shape. Throws
 * on any structural or referential error.
 */
export function normalizeConfig(raw: RawLaunchConfig): NormalizedConfig {
  if (raw && 'function' in raw) {
    throw new Error(
      'invalid config: the legacy single-invoke `function` config has been removed — ' +
        'wrap it in a `transactions` array (see docs/debug-config.md)',
    );
  }
  if (!Array.isArray(raw?.transactions)) {
    throw new Error('invalid config: a `transactions` array is required');
  }

  const steps = parseTransactions(raw.transactions);

  validateHandles(steps);

  const trace = resolveTrace(raw.trace, steps);

  return { steps, trace };
}

/** Parse and validate the new-schema `transactions` array into `TxStep[]`. */
function parseTransactions(transactions: unknown[]): TxStep[] {
  if (transactions.length === 0) {
    throw new Error('invalid config: `transactions` must not be empty');
  }

  return transactions.map((tx, i) => parseStep(tx, i));
}

/** Parse one raw transaction entry into a canonical `TxStep`. */
function parseStep(tx: unknown, index: number): TxStep {
  if (typeof tx !== 'object' || tx === null) {
    throw new Error(`invalid config: transaction at index ${index} is not an object`);
  }
  const t = tx as Record<string, unknown>;

  if (t.kind === 'deploy') {
    if (typeof t.id !== 'string' || t.id.length === 0) {
      throw new Error(`invalid config: deploy at index ${index} is missing a string \`id\``);
    }
    const step: DeployStep = { kind: 'deploy', id: t.id };
    if (typeof t.wasm === 'string') {
      step.wasm = t.wasm;
    }
    if (typeof t.contract === 'string') {
      step.contract = t.contract;
    }
    if (typeof t.buildCommand === 'string') {
      step.buildCommand = t.buildCommand;
    }
    if (typeof t.debugInfo === 'boolean') {
      step.debugInfo = t.debugInfo;
    }
    if (step.wasm === undefined && step.contract === undefined) {
      throw new Error(
        `invalid config: deploy "${t.id}" needs a \`wasm\` path or a \`contract\` dir`,
      );
    }
    return step;
  }

  if (t.kind === 'invoke') {
    if (typeof t.contract !== 'string' || t.contract.length === 0) {
      throw new Error(
        `invalid config: invoke at index ${index} is missing a string \`contract\` handle`,
      );
    }
    if (typeof t.function !== 'string' || t.function.length === 0) {
      throw new Error(
        `invalid config: invoke at index ${index} is missing a string \`function\``,
      );
    }
    const step: InvokeStep = {
      kind: 'invoke',
      contract: t.contract,
      function: t.function,
    };
    if (typeof t.id === 'string' && t.id.length > 0) {
      step.id = t.id;
    }
    if ('args' in t) {
      step.args = t.args;
    }
    return step;
  }

  throw new Error(
    `invalid config: transaction at index ${index} has unknown kind ${JSON.stringify(t.kind)}`,
  );
}

/**
 * Validate that deploy ids are unique and every invoke references a deploy id
 * declared BEFORE it in the sequence.
 */
function validateHandles(steps: TxStep[]): void {
  const known = new Set<string>();
  for (const step of steps) {
    if (step.kind === 'deploy') {
      if (known.has(step.id)) {
        throw new Error(`invalid config: duplicate deploy id "${step.id}"`);
      }
      known.add(step.id);
    } else {
      if (!known.has(step.contract)) {
        throw new Error(
          `invalid config: invoke references unknown deploy id "${step.contract}"`,
        );
      }
    }
  }
}

/**
 * Resolve a trace selector to a 0-based index into `steps`. Undefined and
 * `"last"` map to the final step; an integer must be in range; a string
 * (other than `"last"`) must match a step id — a deploy id or an invoke's
 * optional id.
 */
function resolveTrace(selector: TraceSelector | undefined, steps: TxStep[]): number {
  if (selector === undefined || selector === 'last') {
    return steps.length - 1;
  }

  if (typeof selector === 'number') {
    if (!Number.isInteger(selector) || selector < 0 || selector >= steps.length) {
      throw new Error(
        `invalid config: trace index ${selector} is out of range (0..${steps.length - 1})`,
      );
    }
    return selector;
  }

  const idx = steps.findIndex((s) => s.id === selector);
  if (idx === -1) {
    throw new Error(`invalid config: trace selector "${selector}" names no transaction`);
  }
  return idx;
}
