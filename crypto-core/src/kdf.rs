//! Argon2id key derivation + HKDF stretch into separate enc/wrap subkeys,
//! plus runtime parameter calibration.
//!
//! Flow (PRD §5.1):
//!   master password + salt --Argon2id--> Master Key (256-bit)
//!     --HKDF-expand--> Stretched Master Key { enc subkey, wrap subkey }
//!
//! The master/stretched key never leaves the device and is never stored.

use argon2::{Algorithm, Argon2, Params, Version};
use hkdf::Hkdf;
use secrecy::{ExposeSecret, SecretBox};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};
// (Zeroize derive is applied to StretchedKey so it satisfies SecretBox's bound.)

use crate::error::CoreError;

/// Argon2id cost parameters. Mirrors `KdfParams` in the FFI contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub m_kib: u32,
    /// Time cost (iterations / passes).
    pub t: u32,
    /// Parallelism (lanes).
    pub p: u32,
}

impl KdfParams {
    /// OWASP *login-server* baseline — our absolute floor (PRD §5.1).
    pub const FLOOR: KdfParams = KdfParams { m_kib: 19456, t: 2, p: 1 };

    /// RFC 9106 "second recommended" zone — the default target for an
    /// interactive, once-per-session unlock (PRD §5.1).
    pub const DEFAULT: KdfParams = KdfParams { m_kib: 65536, t: 3, p: 4 };

    /// Clamp params to never fall below the OWASP floor on any axis.
    pub fn clamped(self) -> KdfParams {
        KdfParams {
            m_kib: self.m_kib.max(Self::FLOOR.m_kib),
            t: self.t.max(Self::FLOOR.t),
            p: self.p.max(Self::FLOOR.p),
        }
    }

    fn to_argon2_params(self) -> Result<Params, CoreError> {
        Params::new(self.m_kib, self.t, self.p, Some(MASTER_KEY_LEN))
            .map_err(|e| CoreError::Kdf(format!("invalid Argon2 params: {e}")))
    }
}

/// Length of keys we derive / wrap throughout the core.
pub const KEY_LEN: usize = 32; // 256-bit
const MASTER_KEY_LEN: usize = 32;

/// HKDF context strings — domain-separate the two subkeys.
const HKDF_INFO_ENC: &[u8] = b"mind-shell/vault/v1/enc";
const HKDF_INFO_WRAP: &[u8] = b"mind-shell/vault/v1/wrap";

/// The stretched master key: two domain-separated 256-bit subkeys.
///
/// `enc` is reserved (vault metadata / future direct-encryption use); `wrap`
/// is used to wrap the vault data key. Keeping them separate follows the
/// Bitwarden-style "stretched master key with separate subkeys" design.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct StretchedKey {
    enc: [u8; KEY_LEN],
    wrap: [u8; KEY_LEN],
}

impl StretchedKey {
    /// Subkey used to wrap/unwrap the vault data key.
    pub fn wrap_key(&self) -> &[u8; KEY_LEN] {
        &self.wrap
    }

    /// Reserved enc subkey (kept for parity with the Bitwarden hierarchy).
    #[allow(dead_code)]
    pub fn enc_key(&self) -> &[u8; KEY_LEN] {
        &self.enc
    }
}

/// Derive the stretched master key from the password + salt + Argon2id params.
///
/// `params` is clamped to the floor before use, so a too-weak persisted value
/// cannot downgrade security below OWASP baseline.
pub fn derive_stretched_key(
    password: &[u8],
    salt: &[u8],
    params: KdfParams,
) -> Result<SecretBox<StretchedKey>, CoreError> {
    let params = params.clamped();
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params.to_argon2_params()?);

    let mut master = [0u8; MASTER_KEY_LEN];
    argon
        .hash_password_into(password, salt, &mut master)
        .map_err(|e| CoreError::Kdf(format!("argon2 derive failed: {e}")))?;

    // HKDF-expand the master key into two domain-separated subkeys.
    let hk = Hkdf::<Sha256>::from_prk(&master)
        .map_err(|e| CoreError::Kdf(format!("hkdf prk: {e}")))?;

    let mut enc = [0u8; KEY_LEN];
    let mut wrap = [0u8; KEY_LEN];
    hk.expand(HKDF_INFO_ENC, &mut enc)
        .map_err(|e| CoreError::Kdf(format!("hkdf expand enc: {e}")))?;
    hk.expand(HKDF_INFO_WRAP, &mut wrap)
        .map_err(|e| CoreError::Kdf(format!("hkdf expand wrap: {e}")))?;

    master.zeroize();

    Ok(SecretBox::new(Box::new(StretchedKey { enc, wrap })))
}

/// Time an Argon2id derive at `params` and return milliseconds elapsed.
fn time_derive_ms(params: KdfParams) -> Result<f64, CoreError> {
    let salt = [0x42u8; 16];
    let password = b"calibration-probe-password";
    let start = crate::time::now_ms();
    // Discard the result; we only care about wall-clock cost.
    let _ = derive_stretched_key(password, &salt, params)?;
    Ok(crate::time::now_ms() - start)
}

/// Calibrate Argon2id memory cost to hit ~`target_ms` on this device.
///
/// Strategy: hold t/p at the RFC 9106 default (t=3, p=4) and scale memory,
/// since memory cost dominates Argon2id wall-clock time roughly linearly.
/// Result is clamped to the OWASP floor. Target should be ~500–1000 ms.
pub fn calibrate_kdf(target_ms: f64) -> Result<KdfParams, CoreError> {
    let t = KdfParams::DEFAULT.t;
    let p = KdfParams::DEFAULT.p;

    // Probe at the floor memory to get a per-KiB time estimate.
    let probe = KdfParams { m_kib: KdfParams::FLOOR.m_kib, t, p };
    let probe_ms = time_derive_ms(probe)?.max(0.001);

    // Linear extrapolation: m_target = m_probe * (target_ms / probe_ms).
    let scale = (target_ms / probe_ms).max(1.0);
    let mut m_kib = ((probe.m_kib as f64) * scale).round() as u32;

    // Keep memory sane: floor at OWASP, cap to avoid OOM in browsers (~1 GiB).
    m_kib = m_kib.clamp(KdfParams::FLOOR.m_kib, 1_048_576);
    // Round to a multiple of the parallelism * 8 KiB block requirement.
    let block = 8 * p;
    if m_kib % block != 0 {
        m_kib += block - (m_kib % block);
    }

    Ok(KdfParams { m_kib, t, p }.clamped())
}

/// Constant-time compare of two key-length byte slices.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

// Convenience: expose the wrap subkey bytes for the envelope layer.
pub fn expose_wrap_key(stretched: &SecretBox<StretchedKey>) -> [u8; KEY_LEN] {
    *stretched.expose_secret().wrap_key()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic() {
        let salt = [1u8; 16];
        let a = derive_stretched_key(b"hunter2", &salt, KdfParams::FLOOR).unwrap();
        let b = derive_stretched_key(b"hunter2", &salt, KdfParams::FLOOR).unwrap();
        assert_eq!(expose_wrap_key(&a), expose_wrap_key(&b));
    }

    #[test]
    fn different_password_differs() {
        let salt = [1u8; 16];
        let a = derive_stretched_key(b"hunter2", &salt, KdfParams::FLOOR).unwrap();
        let b = derive_stretched_key(b"hunter3", &salt, KdfParams::FLOOR).unwrap();
        assert_ne!(expose_wrap_key(&a), expose_wrap_key(&b));
    }

    #[test]
    fn enc_and_wrap_subkeys_differ() {
        let salt = [9u8; 16];
        let k = derive_stretched_key(b"pw", &salt, KdfParams::FLOOR).unwrap();
        let s = k.expose_secret();
        assert_ne!(s.enc_key(), s.wrap_key());
    }

    #[test]
    fn params_clamp_to_floor() {
        let weak = KdfParams { m_kib: 8, t: 1, p: 1 }.clamped();
        assert_eq!(weak, KdfParams::FLOOR);
    }
}
