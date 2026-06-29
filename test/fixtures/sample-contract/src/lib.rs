#![no_std]
use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct SampleContract;

#[contractimpl]
impl SampleContract {
    /// Add two unsigned 32-bit integers. The simplest possible invocation to
    /// drive an end-to-end trace through the debugger.
    pub fn add(_env: Env, a: u32, b: u32) -> u32 {
        a + b
    }
}
