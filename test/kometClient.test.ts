import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { KometClient, KometRpcError } from '../src/komet/KometClient';

/**
 * A tiny configurable JSON-RPC server for exercising KometClient's happy and
 * failure paths deterministically (no real komet-node). The responder receives
 * the parsed request body and returns `{ status?, body }`; `body` is sent as
 * JSON (or as a raw string when a string is returned).
 */
type Responder = (msg: any) => { status?: number; body: unknown };

class StubServer {
  private server?: http.Server;
  port = 0;
  constructor(private readonly respond: Responder) {}

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const msg = raw ? JSON.parse(raw) : {};
        const { status = 200, body } = this.respond(msg);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      });
    });
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
}

describe('KometClient', () => {
  let server: StubServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  function ok(result: unknown): Responder {
    return (msg) => ({ body: { jsonrpc: '2.0', id: msg.id, result } });
  }

  it('uses default host/port when none are given', () => {
    const client = new KometClient();
    assert.strictEqual(client.url, 'http://localhost:8000');
  });

  it('returns the JSON-RPC result on success', async () => {
    server = new StubServer(ok({ status: 'healthy' }));
    const port = await server.start();
    const client = new KometClient({ host: '127.0.0.1', port });
    assert.deepStrictEqual(await client.getHealth(), { status: 'healthy' });
  });

  it('reads getNetwork / getLatestLedger / sendTransaction / getTransaction', async () => {
    server = new StubServer((msg) => {
      const byMethod: Record<string, unknown> = {
        getNetwork: { passphrase: 'Test', protocolVersion: '22', friendbotUrl: null },
        getLatestLedger: { id: 'a', protocolVersion: '22', sequence: 3 },
        sendTransaction: { hash: 'deadbeef', status: 'PENDING' },
        getTransaction: { status: 'SUCCESS' },
      };
      return { body: { jsonrpc: '2.0', id: msg.id, result: byMethod[msg.method] } };
    });
    const port = await server.start();
    const client = new KometClient({ host: '127.0.0.1', port });
    assert.strictEqual((await client.getNetwork()).passphrase, 'Test');
    assert.strictEqual((await client.getLatestLedger()).sequence, 3);
    assert.strictEqual((await client.sendTransaction('AAAA')).hash, 'deadbeef');
    assert.strictEqual((await client.getTransaction('deadbeef')).status, 'SUCCESS');
  });

  it('throws KometRpcError when the request cannot connect', async () => {
    // Bind then immediately release a port so nothing is listening on it.
    const tmp = new StubServer(ok({}));
    const port = await tmp.start();
    await tmp.stop();
    const client = new KometClient({ host: '127.0.0.1', port, timeoutMs: 1000 });
    await assert.rejects(() => client.getHealth(), (e: unknown) => {
      assert.ok(e instanceof KometRpcError);
      assert.match((e as Error).message, /failed/);
      return true;
    });
  });

  it('throws KometRpcError on a non-2xx HTTP status', async () => {
    server = new StubServer(() => ({ status: 503, body: { error: 'down' } }));
    const port = await server.start();
    const client = new KometClient({ host: '127.0.0.1', port });
    await assert.rejects(() => client.getHealth(), (e: unknown) => {
      assert.ok(e instanceof KometRpcError);
      assert.match((e as Error).message, /HTTP 503/);
      return true;
    });
  });

  it('throws KometRpcError carrying the JSON-RPC error code and data', async () => {
    server = new StubServer((msg) => ({
      body: { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found', data: { m: 'x' } } },
    }));
    const port = await server.start();
    const client = new KometClient({ host: '127.0.0.1', port });
    await assert.rejects(() => client.call('bogus'), (e: unknown) => {
      assert.ok(e instanceof KometRpcError);
      assert.strictEqual((e as KometRpcError).code, -32601);
      assert.deepStrictEqual((e as KometRpcError).data, { m: 'x' });
      return true;
    });
  });

  it('returns the trace string from traceTransaction', async () => {
    server = new StubServer(ok('{"pos":0}\n{"pos":1}'));
    const port = await server.start();
    const client = new KometClient({ host: '127.0.0.1', port });
    assert.strictEqual(await client.traceTransaction('h'), '{"pos":0}\n{"pos":1}');
  });

  it('rejects an empty trace from traceTransaction', async () => {
    server = new StubServer(ok('   '));
    const port = await server.start();
    const client = new KometClient({ host: '127.0.0.1', port });
    await assert.rejects(() => client.traceTransaction('h'), /no trace/);
  });

  it('rejects a non-string trace from traceTransaction', async () => {
    server = new StubServer(ok(42));
    const port = await server.start();
    const client = new KometClient({ host: '127.0.0.1', port });
    await assert.rejects(() => client.traceTransaction('h'), /no trace/);
  });

  it('waitForHealthy resolves once the node reports healthy', async () => {
    let calls = 0;
    server = new StubServer((msg) => ({
      body: { jsonrpc: '2.0', id: msg.id, result: { status: ++calls >= 2 ? 'healthy' : 'starting' } },
    }));
    const port = await server.start();
    const client = new KometClient({ host: '127.0.0.1', port });
    await client.waitForHealthy(2000, 5);
    assert.ok(calls >= 2);
  });

  it('waitForHealthy throws after the deadline when never healthy', async () => {
    server = new StubServer(ok({ status: 'starting' }));
    const port = await server.start();
    const client = new KometClient({ host: '127.0.0.1', port });
    await assert.rejects(() => client.waitForHealthy(30, 5), (e: unknown) => {
      assert.ok(e instanceof KometRpcError);
      assert.match((e as Error).message, /did not become healthy/);
      return true;
    });
  });

  it('waitForHealthy surfaces the last connection error in its timeout message', async () => {
    const tmp = new StubServer(ok({}));
    const port = await tmp.start();
    await tmp.stop();
    const client = new KometClient({ host: '127.0.0.1', port, timeoutMs: 200 });
    await assert.rejects(() => client.waitForHealthy(30, 5), /did not become healthy/);
  });
});
