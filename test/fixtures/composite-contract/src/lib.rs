#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

/// Mirrors the real `HubAssetKey`: a user-defined enum with a unit variant, an
/// Address-carrying variant, and an integer-carrying variant. Exercises union
/// encoding via the contract spec.
#[contracttype]
#[derive(Clone)]
pub enum AssetKey {
    Native,
    Stellar(Address),
    Other(u32),
}

/// Fixture for spec-driven composite-arg encoding (blocker #4). `supply` takes
/// `Vec<(AssetKey, i128)>` — a vector of tuples of a user-defined enum and a
/// 128-bit int, mirroring the real `supply(requests: Vec<(HubAssetKey, i128)>)`.
#[contract]
pub struct Composite;

#[contractimpl]
impl Composite {
    pub fn supply(env: Env, requests: Vec<(AssetKey, i128)>) -> u32 {
        let _ = env;
        requests.len()
    }
}
