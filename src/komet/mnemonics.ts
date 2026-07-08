/**
 * Normalization of komet-node's K-style instruction spellings into standard
 * wasm text-format mnemonics.
 *
 * komet-node emits trace instructions as arrays `[op]` or `[op, typeOrImm,
 * ...imms]`. When the FIRST element after the op is one of the value types
 * ('i32' | 'i64' | 'f32' | 'f64') it is a type qualifier, not an immediate:
 * `["const","i64",255]` means `i64.const 255`, `["and","i64"]` means
 * `i64.and`, `["wrap_i64","i32"]` means `i32.wrap_i64`. Any other trailing
 * elements are immediates: `["local.get",0]`, `["br_if",0]` (a label, not a
 * type), `["call",7]`. `["unknown"]` is komet's placeholder for instructions
 * its printer cannot decode (e.g. `if`).
 *
 * Pure module (no `vscode` imports, no external deps).
 */

const TYPE_QUALIFIERS = new Set(['i32', 'i64', 'f32', 'f64']);
const UNKNOWN_OP = 'unknown';

/** The type qualifier of an instr, or null when its operands are all immediates. */
function typeQualifier(instr: [string, ...unknown[]]): string | null {
  const first = instr[1];
  return typeof first === 'string' && TYPE_QUALIFIERS.has(first) ? first : null;
}

/**
 * The wasm text-format mnemonic of a komet instr array ('i64.const', 'br_if',
 * 'local.get'), or null for komet's 'unknown' placeholder.
 */
export function normalizeMnemonic(instr: [string, ...unknown[]]): string | null {
  const op = instr[0];
  if (op === UNKNOWN_OP) {
    return null;
  }
  const type = typeQualifier(instr);
  return type === null ? op : `${type}.${op}`;
}

/**
 * Full instruction text: the normalized mnemonic followed by the immediates,
 * space-separated ('i64.const 255', 'br_if 0'). The 'unknown' placeholder
 * renders as 'unknown'.
 */
export function renderInstr(instr: [string, ...unknown[]]): string {
  const mnemonic = normalizeMnemonic(instr);
  if (mnemonic === null) {
    return UNKNOWN_OP;
  }
  const immediates = instr.slice(typeQualifier(instr) === null ? 1 : 2);
  return [mnemonic, ...immediates.map(String)].join(' ');
}
