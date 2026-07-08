#![no_std]
//! Control-flow fixtures for the stepping test suite. Each entry point isolates
//! one Rust construct (sequence, if/else, `for`, `while` + call, `match`) so the
//! golden traces pin how the debugger steps over that construct. Built by the
//! debugger with opt-level=0 (see ContractBuilder) to keep per-statement line
//! info; all arithmetic is `wrapping_*` so `overflow-checks = true` never traps.
use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct Control;

/// A leaf callee with a real frame (never inlined) so `for`/`while` bodies that
/// call it exercise step-in / step-over across a genuine call boundary.
#[inline(never)]
fn bump(x: u32) -> u32 {
    let y = x.wrapping_add(1);
    y.wrapping_mul(2)
}

#[contractimpl]
impl Control {
    /// Straight-line sequence: three dependent statements, no branches.
    pub fn seq(_env: Env, x: u32) -> u32 {
        let a = x.wrapping_add(1);
        let b = a.wrapping_mul(2);
        let c = b.wrapping_sub(3);
        c
    }

    /// if / else: exactly one arm runs, and stepping must enter only that arm.
    pub fn branch(_env: Env, x: u32) -> u32 {
        let r;
        if x > 10 {
            r = x.wrapping_sub(10);
        } else {
            r = x.wrapping_add(100);
        }
        r
    }

    /// `for` over a range: the loop header and body each stop once per iteration.
    pub fn count(_env: Env, n: u32) -> u32 {
        let mut acc: u32 = 0;
        for i in 0..n {
            acc = acc.wrapping_add(i);
        }
        acc
    }

    /// `while` with a real call in the body: per-iteration stops plus step-in to
    /// `bump` and step-over past it.
    pub fn while_call(_env: Env, n: u32) -> u32 {
        let mut acc: u32 = 0;
        let mut i: u32 = 0;
        while i < n {
            acc = acc.wrapping_add(bump(i));
            i = i.wrapping_add(1);
        }
        acc
    }

    /// `match`: only the selected arm executes.
    pub fn choose(_env: Env, x: u32) -> u32 {
        let r = match x % 3 {
            0 => 100,
            1 => 200,
            _ => 300,
        };
        r
    }
}
