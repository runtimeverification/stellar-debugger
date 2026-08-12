/**
 * Builds the base64 XDR TransactionEnvelopes the turnkey pipeline submits to
 * komet-node: seed account, upload wasm, create contract, and invoke.
 *
 * komet-node ignores fees, signatures, footprints, and SorobanTransactionData,
 * so there is no simulate/prepare step — we build raw envelopes directly. It
 * ignores sequence numbers too, but they still distinguish envelopes: see
 * `sequence` below. (Transactions are still signed for forward-compatibility
 * with real Stellar RPC.)
 *
 * Pure module; depends only on @stellar/stellar-sdk.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  hash,
  xdr,
} from '@stellar/stellar-sdk';
import { deriveContractId } from './contractId';

export interface UploadResult {
  envelopeXdr: string;
  /** SHA-256 of the wasm bytes; the key used by createContract. */
  wasmHash: Buffer;
}

export interface CreateContractResult {
  envelopeXdr: string;
  /** Salt used; needed to reproduce the contract ID. */
  salt: Buffer;
  /** Derived "C..." contract ID. */
  contractId: string;
}

export class SorobanTxBuilder {
  /**
   * Account sequence of the NEXT envelope built. komet-node ignores sequence
   * numbers for EXECUTION, but the sequence is part of the signed envelope, so
   * two otherwise-identical transactions built with the same sequence hash to
   * the same bytes and komet-node dedups the second (returns the first's cached
   * receipt without re-executing). Every envelope this builder produces
   * therefore gets its own sequence, which is what keeps byte-identical invokes
   * in one run independently executed.
   */
  private sequence = 0;

  constructor(private readonly networkPassphrase: string) {}

  /** A fresh TransactionBuilder at the next unused account sequence. */
  private newBuilder(source: Keypair): TransactionBuilder {
    const account = new Account(source.publicKey(), String(this.sequence++));
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });
  }

  private finish(builder: TransactionBuilder, signer: Keypair): string {
    const tx = builder.setTimeout(0).build();
    tx.sign(signer);
    return tx.toEnvelope().toXDR('base64');
  }

  /**
   * Seed an account. komet-node maps CreateAccount to its `setAccount` step.
   * The source is the account itself (self-seed) because the node boots from an
   * empty state with no pre-funded genesis account.
   */
  buildCreateAccount(account: Keypair, startingBalance = '100000000'): string {
    const builder = this.newBuilder(account).addOperation(
      Operation.createAccount({
        destination: account.publicKey(),
        startingBalance,
      }),
    );
    return this.finish(builder, account);
  }

  /** Upload contract wasm; returns the envelope and the wasm hash. */
  buildUploadWasm(source: Keypair, wasm: Buffer): UploadResult {
    const builder = this.newBuilder(source).addOperation(
      Operation.uploadContractWasm({ wasm }),
    );
    return { envelopeXdr: this.finish(builder, source), wasmHash: hash(wasm) };
  }

  /** Create a contract instance from an uploaded wasm hash. */
  buildCreateContract(source: Keypair, wasmHash: Buffer, salt: Buffer): CreateContractResult {
    const builder = this.newBuilder(source).addOperation(
      Operation.createCustomContract({
        address: Address.fromString(source.publicKey()),
        wasmHash,
        salt,
      }),
    );
    const contractId = deriveContractId(source.publicKey(), salt, this.networkPassphrase);
    return { envelopeXdr: this.finish(builder, source), salt, contractId };
  }

  /** Invoke a contract function with the given ScVal arguments. */
  buildInvoke(source: Keypair, contractId: string, fn: string, args: xdr.ScVal[]): string {
    const contract = new Contract(contractId);
    const builder = this.newBuilder(source).addOperation(contract.call(fn, ...args));
    return this.finish(builder, source);
  }
}
