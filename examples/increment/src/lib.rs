#![no_std]
use soroban_sdk::{contract, contractimpl, Env, Symbol, symbol_short};

const COUNTER: Symbol = symbol_short!("COUNTER");

/// A stateful counter — a better showcase for *time-travel* debugging than pure
/// arithmetic, since you can watch persistent storage change and then step
/// backwards to see the previous value.
///
/// Requires the live pipeline (a real build + komet-node), so run it with the
/// "Soroban: Debug increment()" launch config.
#[contract]
pub struct Increment;

#[contractimpl]
impl Increment {
    /// Read the current counter from instance storage, add `by`, write it back,
    /// and return the new value.
    pub fn increment(env: Env, by: u32) -> u32 {
        let current: u32 = env.storage().instance().get(&COUNTER).unwrap_or(0);
        let next = current + by;
        env.storage().instance().set(&COUNTER, &next);
        next
    }
}
