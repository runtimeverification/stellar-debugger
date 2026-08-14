/**
 * The argv tokenizer both CLI front doors (`soroban-trace`, `soroban-dap`) parse
 * with, so they agree on what an option looks like and on how a bad one reads.
 *
 * Deliberately minimal — no `--flag=value`, no clustering, no positionals: every
 * token is either a declared switch, a declared option followed by its value, or
 * an error. That is the whole surface these two commands need, and it keeps the
 * per-command parsers down to their own semantics.
 *
 * PURE: never reads process.argv, never prints, never exits.
 */

/** Which options a command accepts. */
export interface FlagSpec {
  /** Options taking a following value, e.g. `--out <file>`. */
  value: readonly string[];
  /** Bare switches, e.g. `--allow-no-source`. */
  switches?: readonly string[];
}

/** Outcome of tokenizing argv against a `FlagSpec`. */
export type FlagResult =
  | {
      ok: true;
      /** Value of each `--option value` seen; last occurrence wins. */
      values: Readonly<Record<string, string>>;
      /** The switches present. */
      switches: ReadonlySet<string>;
    }
  | { ok: false; message: string };

/** Whether argv asks for help, which wins over everything else. */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('-h') || argv.includes('--help');
}

/**
 * Tokenize `argv` against `spec`. An option missing its value, an option that is
 * not declared, and a bare (non-option) argument are all errors; the message
 * names the offending token and is ready to have a usage hint appended.
 */
export function parseFlags(argv: readonly string[], spec: FlagSpec): FlagResult {
  const valueFlags = new Set(spec.value);
  const switchFlags = new Set(spec.switches ?? []);
  const values: Record<string, string> = {};
  const switches = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (valueFlags.has(token)) {
      const next = argv[i + 1];
      // A following option is never a value: `--out --depth 2` is a missing value,
      // not a file named "--depth".
      if (next === undefined || next.startsWith('-')) {
        return { ok: false, message: `Missing value for ${token}` };
      }
      values[token] = next;
      i++;
    } else if (switchFlags.has(token)) {
      switches.add(token);
    } else if (token.startsWith('-')) {
      return { ok: false, message: `Unknown option: ${token}` };
    } else {
      return { ok: false, message: `Unexpected argument: ${token}` };
    }
  }

  return { ok: true, values, switches };
}

/** Whether a string is a non-negative integer literal. */
export function isNonNegativeInt(s: string): boolean {
  return /^\d+$/.test(s);
}
