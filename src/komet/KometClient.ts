/**
 * JSON-RPC client for komet-node.
 *
 * komet-node exposes a Stellar-RPC-shaped JSON-RPC API (default
 * http://localhost:8000) with six methods: getHealth, getNetwork,
 * getLatestLedger, sendTransaction, getTransaction, and the non-standard
 * traceTransaction.
 *
 * A transaction is submitted as a base64 XDR TransactionEnvelope via
 * `sendTransaction`, which returns its hash. The execution trace is then
 * fetched by hash: `traceTransaction({hash})` returns the JSONL trace as a
 * bare string (one JSON record per executed wasm instruction). The final
 * SUCCESS/FAILED status comes from `getTransaction({hash})` — the trace result
 * itself carries no status. (Verified against komet-node installed via
 * `kup install komet-node`.)
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
   * Fetch the JSONL execution trace for an already-submitted transaction.
   * Returns the trace as a bare newline-separated string (one JSON record per
   * executed wasm instruction). Throws if the node returns no trace for the
   * hash (e.g. the transaction was not a contract invocation).
   */
  async traceTransaction(hash: string): Promise<string> {
    const trace = await this.call<string>('traceTransaction', { hash });
    if (typeof trace !== 'string' || trace.trim() === '') {
      throw new KometRpcError(
        `traceTransaction returned no trace for ${hash}. ` +
          'Was the transaction a contract invocation?',
      );
    }
    return trace;
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
