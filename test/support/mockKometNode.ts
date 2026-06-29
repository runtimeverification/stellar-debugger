/**
 * A faithful in-process mock of komet-node's JSON-RPC API, for deterministic
 * pipeline tests without the real K-based node. It implements the same six
 * methods (getHealth, getNetwork, getLatestLedger, sendTransaction,
 * getTransaction, traceTransaction), records every submitted envelope, and
 * returns a canned JSONL trace from traceTransaction.
 */

import * as http from 'http';
import { AddressInfo } from 'net';
import { Networks } from '@stellar/stellar-sdk';

export interface MockOptions {
  /** JSONL trace returned by traceTransaction. */
  trace: string;
  /** Override the transaction status reported by traceTransaction. */
  traceStatus?: string;
}

export class MockKometNode {
  private server?: http.Server;
  port = 0;

  /** Envelopes received, in order, keyed by method. */
  readonly received: { method: string; transaction: string }[] = [];
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

  /** Envelopes received via a given method. */
  envelopes(method: string): string[] {
    return this.received.filter((r) => r.method === method).map((r) => r.transaction);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let id: unknown = null;
      try {
        const msg = JSON.parse(body);
        id = msg.id;
        const result = this.dispatch(msg.method, msg.params ?? {});
        this.send(res, { jsonrpc: '2.0', id, result });
      } catch (e) {
        this.send(res, { jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } });
      }
    });
  }

  private dispatch(method: string, params: any): unknown {
    switch (method) {
      case 'getHealth':
        return { status: 'healthy' };
      case 'getNetwork':
        return { passphrase: Networks.TESTNET, protocolVersion: '22', friendbotUrl: null };
      case 'getLatestLedger':
        return { id: '0'.repeat(64), protocolVersion: '22', sequence: this.ledger };
      case 'sendTransaction': {
        this.received.push({ method, transaction: params.transaction });
        const hash = this.hashFor(this.received.length);
        this.ledger++;
        return { hash, status: 'PENDING', latestLedger: String(this.ledger) };
      }
      case 'traceTransaction': {
        this.received.push({ method, transaction: params.transaction });
        const hash = this.hashFor(this.received.length);
        this.ledger++;
        return {
          hash,
          status: this.opts.traceStatus ?? 'SUCCESS',
          ledger: String(this.ledger),
          trace: this.opts.trace,
        };
      }
      case 'getTransaction':
        return { status: 'SUCCESS', trace: this.opts.trace };
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
