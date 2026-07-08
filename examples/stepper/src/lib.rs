#![no_std]
use soroban_sdk::{contract, contractimpl, Env};

/// A contract built to exercise the debugger's stepping semantics: it has a
/// real function call (`triple` is `#[inline(never)]`, so the wasm contains a
/// `call` instruction) and a real loop (the `while` compiles to a backward
/// `br_if`, which komet-node's tracer can decode — unlike `if`).
///
/// `sum_triples(n)` returns `3 * (0 + 1 + ... + n-1)` using wrapping
/// arithmetic so no overflow-check `if` blocks are generated.
#[contract]
pub struct Stepper;

#[inline(never)]
fn triple(x: u32) -> u32 {
    let doubled = x.wrapping_mul(2);
    doubled.wrapping_add(x)
}

#[contractimpl]
impl Stepper {
    pub fn sum_triples(_env: Env, n: u32) -> u32 {
        let mut acc: u32 = 0;
        let mut i: u32 = 0;
        while i < n {
            acc = acc.wrapping_add(triple(i));
            i = i.wrapping_add(1);
        }
        acc
    }
}
