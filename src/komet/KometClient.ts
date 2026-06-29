/**
 * JSON-RPC client for komet-node.
 *
 * komet-node exposes a Stellar-RPC-shaped JSON-RPC API (default
 * http://localhost:8000) with six methods: getHealth, getNetwork,
 * getLatestLedger, sendTransaction, getTransaction, and the non-standard
 * traceTransaction. Transactions are passed as base64 XDR TransactionEnvelopes.
 *
 * OPEN QUESTION (to verify against a live node — see plan): whether
 * `traceTransaction` returns the JSONL trace inline in its result, or whether
 * the trace must be fetched via a follow-up `getTransaction`. We handle both:
 * `traceTransaction()` returns the inline trace when present and otherwise
 * falls back to getTransaction(hash).trace.
 *
 * Pure module (uses global fetch, no `vscode` imports) so it can be tested
 * against a mock HTTP server.
 */

export interface KometClientOptions {
  host?: string;
  port?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface SendTransactionResult {
  hash: string;
  status: string; // typically "PENDING"
  latestLedger?: string;
  latestLedgerCloseTime?: string;
}

export interface GetTransactionResult {
  status: 'NOT_FOUND' | 'SUCCESS' | 'FAILED' | string;
  ledger?: string;
  createdAt?: string;
  envelopeXdr?: string;
  resultXdr?: string;
  resultMetaXdr?: string;
  /** Newline-separated JSON trace records, or null/absent when not traced. */
  trace?: string | null;
  latestLedger?: string;
  latestLedgerCloseTime?: string;
}

export class KometRpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = 'KometRpcError';
  }
}

export class KometClient {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(opts: KometClientOptions = {}) {
    this.host = opts.host ?? 'localhost';
    this.port = opts.port ?? 8000;
    this.url = `http://${this.host}:${this.port}`;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Low-level JSON-RPC call with named params. */
  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params: params ?? {},
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new KometRpcError(`request to ${this.url} failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new KometRpcError(`HTTP ${res.status} from ${this.url}`);
    }

    const payload = (await res.json()) as { result?: T; error?: { code?: number; message?: string; data?: unknown } };
    if (payload.error) {
      throw new KometRpcError(payload.error.message ?? 'JSON-RPC error', payload.error.code, payload.error.data);
    }
    return payload.result as T;
  }

  async getHealth(): Promise<{ status: string }> {
    return this.call('getHealth');
  }

  async getNetwork(): Promise<{ passphrase: string; protocolVersion: string; friendbotUrl: string | null }> {
    return this.call('getNetwork');
  }

  async getLatestLedger(): Promise<{ id: string; protocolVersion: string; sequence: number }> {
    return this.call('getLatestLedger');
  }

  /** Submit a base64 XDR TransactionEnvelope without tracing. */
  async sendTransaction(envelopeXdrBase64: string): Promise<SendTransactionResult> {
    return this.call('sendTransaction', { transaction: envelopeXdrBase64 });
  }

  async getTransaction(hash: string): Promise<GetTransactionResult> {
    return this.call('getTransaction', { hash });
  }

  /**
   * Submit a transaction with tracing enabled and return the raw JSONL trace.
   * Tries the inline trace from the traceTransaction result first, then falls
   * back to getTransaction(hash).trace.
   */
  async traceTransaction(envelopeXdrBase64: string): Promise<{ hash: string; trace: string; result: GetTransactionResult }> {
    const traceResult = await this.call<GetTransactionResult & { hash?: string }>('traceTransaction', {
      transaction: envelopeXdrBase64,
    });

    let hash = traceResult.hash;
    let trace = traceResult.trace ?? undefined;
    let finalResult: GetTransactionResult = traceResult;

    if ((trace === undefined || trace === null) && hash) {
      finalResult = await this.getTransaction(hash);
      trace = finalResult.trace ?? undefined;
    }

    if (trace === undefined || trace === null) {
      throw new KometRpcError(
        'traceTransaction returned no trace (neither inline nor via getTransaction). ' +
          'Was the node started with --trace, and is the transaction a contract invocation?',
      );
    }
    if (!hash) {
      hash = '';
    }
    return { hash, trace, result: finalResult };
  }

  /** Poll getHealth until healthy or the deadline passes. */
  async waitForHealthy(deadlineMs: number, intervalMs = 500): Promise<void> {
    const start = Date.now();
    let lastErr: unknown;
    while (Date.now() - start < deadlineMs) {
      try {
        const h = await this.getHealth();
        if (h.status === 'healthy') {
          return;
        }
      } catch (e) {
        lastErr = e;
      }
      await delay(intervalMs);
    }
    throw new KometRpcError(
      `komet-node at ${this.url} did not become healthy within ${deadlineMs}ms` +
        (lastErr ? `: ${(lastErr as Error).message}` : ''),
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
