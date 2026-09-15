#![no_std]
use soroban_sdk::{contract, contractimpl, Env};

/// A contract whose wasm carries a DataCount section (id 12).
///
/// Every other fixture here is too small to need one: with no static data the
/// toolchain emits no Data section, so it emits no DataCount either. That is
/// why the upload path could reject real contracts while the whole fixture set
/// passed. This contract holds a static table big enough to land in linear
/// memory, which makes the toolchain emit both sections.
///
/// Keep the table. Shrinking it away, or letting the optimiser fold it into
/// immediates, removes the data segment and the fixture stops testing anything.
///
/// Rebuild with:
///   cd test/fixtures/datacount-contract && stellar contract build --out-dir /tmp/dc
///   cp /tmp/dc/datacount_contract.wasm test/fixtures/datacount_contract.wasm
#[contract]
pub struct DataCountContract;

/// 256 distinct bytes, read by index so the optimiser cannot fold the table.
static TABLE: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        t[i] = (i as u8).wrapping_mul(31).wrapping_add(7);
        i += 1;
    }
    t
};

#[contractimpl]
impl DataCountContract {
    /// Look up one entry of the static table.
    pub fn lookup(_env: Env, index: u32) -> u32 {
        TABLE[(index % 256) as usize] as u32
    }
}
