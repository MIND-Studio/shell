//! CSPRNG access. Uses `OsRng`, which in WASM is backed by `getrandom`'s `js`
//! feature (browser `crypto.getRandomValues`).

pub use rand::rngs::OsRng;

/// The process/device CSPRNG.
pub fn os_rng() -> OsRng {
    OsRng
}
