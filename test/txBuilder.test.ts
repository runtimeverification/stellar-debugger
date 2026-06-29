import * as assert from 'assert';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  xdr,
  hash,
  StrKey,
  scValToNative,
} from '@stellar/stellar-sdk';
import { SorobanTxBuilder } from '../src/soroban/SorobanTxBuilder';
import { deriveContractId } from '../src/soroban/contractId';
import { encodeArgs } from '../src/soroban/scval';

const NET = Networks.TESTNET;

describe('SorobanTxBuilder', () => {
  const source = Keypair.random();
  const builder = new SorobanTxBuilder(NET);

  it('builds a signed CreateAccount envelope', () => {
    const xdrStr = builder.buildCreateAccount(source, '100');
    const tx = TransactionBuilder.fromXDR(xdrStr, NET);
    const op = (tx as any).operations[0];
    assert.strictEqual(op.type, 'createAccount');
    assert.strictEqual(op.destination, source.publicKey());
    assert.strictEqual((tx as any).signatures.length, 1);
  });

  it('builds an uploadContractWasm envelope and the correct wasm hash', () => {
    const wasm = Buffer.from('0061736d01000000', 'hex'); // wasm magic + version
    const { envelopeXdr, wasmHash } = builder.buildUploadWasm(source, wasm);
    assert.deepStrictEqual(wasmHash, hash(wasm));
    const tx = TransactionBuilder.fromXDR(envelopeXdr, NET);
    const op = (tx as any).operations[0];
    assert.strictEqual(op.type, 'invokeHostFunction');
    assert.strictEqual(op.func.switch().name, 'hostFunctionTypeUploadContractWasm');
  });

  it('builds a createCustomContract envelope and derives the contract id', () => {
    const wasmHash = hash(Buffer.from('abcd', 'hex'));
    const salt = Buffer.alloc(32, 7);
    const { envelopeXdr, contractId } = builder.buildCreateContract(source, wasmHash, salt);
    assert.ok(StrKey.isValidContract(contractId), 'expected a valid C... contract id');
    assert.strictEqual(contractId, deriveContractId(source.publicKey(), salt, NET));
    const tx = TransactionBuilder.fromXDR(envelopeXdr, NET);
    const op = (tx as any).operations[0];
    assert.strictEqual(op.type, 'invokeHostFunction');
    assert.strictEqual(op.func.switch().name, 'hostFunctionTypeCreateContractV2');
  });

  it('builds an invoke envelope calling the named function with args', () => {
    const salt = Buffer.alloc(32, 7);
    const contractId = deriveContractId(source.publicKey(), salt, NET);
    const xdrStr = builder.buildInvoke(source, contractId, 'add', encodeArgs([
      { value: 5, type: 'u32' },
      { value: 6, type: 'u32' },
    ]));
    const tx = TransactionBuilder.fromXDR(xdrStr, NET);
    const op = (tx as any).operations[0];
    assert.strictEqual(op.type, 'invokeHostFunction');
    const invoke = op.func.invokeContract();
    assert.strictEqual(invoke.functionName().toString(), 'add');
    const callArgs = invoke.args().map((a: xdr.ScVal) => Number(scValToNative(a)));
    assert.deepStrictEqual(callArgs, [5, 6]);
  });

  it('derives a deterministic contract id (stable across calls)', () => {
    const salt = Buffer.alloc(32, 9);
    const a = deriveContractId(source.publicKey(), salt, NET);
    const b = deriveContractId(source.publicKey(), salt, NET);
    assert.strictEqual(a, b);
    const c = deriveContractId(source.publicKey(), Buffer.alloc(32, 10), NET);
    assert.notStrictEqual(a, c);
  });
});
