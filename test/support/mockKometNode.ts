/**
 * A faithful in-process mock of komet-node's JSON-RPC API, for deterministic
 * pipeline tests without the real K-based node. It implements the same six
 * methods (getHealth, getNetwork, getLatestLedger, sendTransaction,
 * getTransaction, traceTransaction).
 *
 * Mirrors the live protocol: transactions are submitted via sendTransaction
 * (which returns a hash), traceTransaction({hash}) returns the canned JSONL
 * trace as a bare string, and getTransaction({hash}) reports the status.
 */

import * as http from 'http';
import { AddressInfo } from 'net';
import { Networks } from '@stellar/stellar-sdk';

export interface MockOptions {
  /** JSONL trace returned by traceTransaction. */
  trace: string;
  /** Override the transaction status reported by getTransaction. */
  traceStatus?: string;
}

export class MockKometNode {
  private server?: http.Server;
  port = 0;

  /** Calls received, in order: the method and its params. */
  readonly received: { method: string; params: any }[] = [];
  private ledger = 1;

  constructor(private readonly opts: MockOptions) {}

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
  }

  /** Transaction envelopes submitted via a given method (e.g. sendTransaction). */
  envelopes(method: string): string[] {
    return this.received.filter((r) => r.method === method).map((r) => r.params.transaction);
  }

  /** Number of times a given method was called. */
  calls(method: string): number {
    return this.received.filter((r) => r.method === method).length;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let id: unknown = null;
      try {
        const msg = JSON.parse(body);
        id = msg.id;
        this.received.push({ method: msg.method, params: msg.params ?? {} });
        const result = this.dispatch(msg.method);
        this.send(res, { jsonrpc: '2.0', id, result });
      } catch (e) {
        this.send(res, { jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } });
      }
    });
  }

  private dispatch(method: string): unknown {
    switch (method) {
      case 'getHealth':
        return { status: 'healthy' };
      case 'getNetwork':
        return { passphrase: Networks.TESTNET, protocolVersion: '22', friendbotUrl: null };
      case 'getLatestLedger':
        return { id: '0'.repeat(64), protocolVersion: '22', sequence: this.ledger };
      case 'sendTransaction': {
        const hash = this.hashFor(this.calls('sendTransaction'));
        this.ledger++;
        return { hash, status: 'PENDING', latestLedger: String(this.ledger) };
      }
      case 'traceTransaction':
        // The live node returns the JSONL trace as a bare string, keyed by hash.
        return this.opts.trace;
      case 'getTransaction':
        return {
          status: this.opts.traceStatus ?? 'SUCCESS',
          ledger: String(this.ledger),
        };
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  private hashFor(n: number): string {
    return n.toString(16).padStart(64, '0');
  }

  private send(res: http.ServerResponse, payload: unknown): void {
    const data = JSON.stringify(payload);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(data);
  }
}
