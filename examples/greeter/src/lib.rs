#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol};

const LAST: Symbol = symbol_short!("LAST");

/// A contract whose entry point returns **nothing** (unit / `Void`).
#[contract]
pub struct Greeter;

#[contractimpl]
impl Greeter {
    /// Store a number in instance storage and return nothing.
    pub fn store(env: Env, value: u32) {
        env.storage().instance().set(&LAST, &value);
    }
}
