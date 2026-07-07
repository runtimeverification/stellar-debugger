#![no_std]
use soroban_sdk::{contract, contractimpl, Env};

/// The simplest possible Soroban contract: pure arithmetic, no storage.
///
/// This is the contract behind the bundled `traces/add.trace.jsonl`, so you can
/// time-travel through its execution with **no toolchain and no komet-node**
/// using the "Soroban: Replay add(4, 3) trace" launch config.
#[contract]
pub struct Adder;

#[contractimpl]
impl Adder {
    /// Add two unsigned 32-bit integers.
    pub fn add(_env: Env, a: u32, b: u32) -> u32 {
        a + b
    }
}
