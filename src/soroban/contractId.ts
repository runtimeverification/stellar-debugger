/**
 * Client-side derivation of a Soroban contract ID.
 *
 * When a contract is created from a source account + salt, its address is
 * deterministically derived from the network passphrase, the deployer address,
 * and the salt. komet-node computes the same address from the create-contract
 * operation, so deriving it here lets the pipeline reference the contract for
 * the subsequent invoke without round-tripping through the node.
 *
 * contractId = SHA256( HashIDPreimage::ENVELOPE_TYPE_CONTRACT_ID {
 *   networkID = SHA256(passphrase),
 *   contractIDPreimage = FROM_ADDRESS { address, salt },
 * } )
 *
 * Pure module; depends only on @stellar/stellar-sdk.
 */

import { Address, StrKey, hash, xdr } from '@stellar/stellar-sdk';

/** Derive the "C..." contract ID for a contract created by `deployer` + `salt`. */
export function deriveContractId(deployerPublicKey: string, salt: Buffer, networkPassphrase: string): string {
  if (salt.length !== 32) {
    throw new Error(`salt must be 32 bytes, got ${salt.length}`);
  }
  const networkId = hash(Buffer.from(networkPassphrase));

  const contractIdPreimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: Address.fromString(deployerPublicKey).toScAddress(),
      salt,
    }),
  );

  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage,
    }),
  );

  const contractId = hash(preimage.toXDR());
  return StrKey.encodeContract(contractId);
}
