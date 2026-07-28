#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

const ADMIN: Symbol = symbol_short!("ADMIN");

/// Probe: does komet execute `__constructor` as an ordinary call, and do its
/// storage writes persist to a later transaction?
///
/// `admin_set(nonce)` returns whether ADMIN exists — it never traps, and the
/// `nonce` arg lets two calls produce DIFFERENT tx hashes so komet-node does not
/// dedup the second as a duplicate. Expect false before __constructor, true
/// after: a clean cross-transaction persistence proof.
#[contract]
pub struct CtorProbe;

#[contractimpl]
impl CtorProbe {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&ADMIN, &admin);
    }

    pub fn admin_set(env: Env, _nonce: u32) -> bool {
        env.storage().instance().has(&ADMIN)
    }
}
