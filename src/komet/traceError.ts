/**
 * The single error type for trace-parsing failures, in its own module so that
 * `trace.ts` and `traceEvents.ts` can both use it without a circular import
 * (`trace.ts` calls into `traceEvents.ts` and re-exports its types).
 *
 * Pure module (no `vscode` / DAP imports).
 */

export class TraceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceParseError';
  }
}
