//! RFC 6238 TOTP (over RFC 4226 HOTP) with HMAC-SHA1. Hand-rolled on top of
//! `sha1` to avoid an extra dependency; the host supplies trusted time.

use sha1::{Digest, Sha1};

use crate::error::CoreError;

const BLOCK: usize = 64; // SHA-1 block size

/// HMAC-SHA1(key, msg).
fn hmac_sha1(key: &[u8], msg: &[u8]) -> [u8; 20] {
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let d = Sha1::digest(key);
        k[..20].copy_from_slice(&d);
    } else {
        k[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }

    let mut inner = Sha1::new();
    inner.update(ipad);
    inner.update(msg);
    let inner_digest = inner.finalize();

    let mut outer = Sha1::new();
    outer.update(opad);
    outer.update(inner_digest);
    let out = outer.finalize();

    let mut result = [0u8; 20];
    result.copy_from_slice(&out);
    result
}

/// Decode an RFC 4648 base32 secret (upper/lowercase, optional `=` padding,
/// spaces ignored).
fn base32_decode(s: &str) -> Result<Vec<u8>, CoreError> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    for c in s.chars() {
        if c == '=' || c.is_whitespace() || c == '-' {
            continue;
        }
        let uc = c.to_ascii_uppercase() as u8;
        let val = ALPHABET
            .iter()
            .position(|&a| a == uc)
            .ok_or_else(|| CoreError::Invalid(format!("invalid base32 char: {c}")))?
            as u32;
        buffer = (buffer << 5) | val;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

/// HOTP per RFC 4226 for an explicit 8-byte counter.
fn hotp(secret: &[u8], counter: u64, digits: u32) -> String {
    let msg = counter.to_be_bytes();
    let mac = hmac_sha1(secret, &msg);
    let offset = (mac[19] & 0x0f) as usize;
    let bin = ((u32::from(mac[offset]) & 0x7f) << 24)
        | (u32::from(mac[offset + 1]) << 16)
        | (u32::from(mac[offset + 2]) << 8)
        | u32::from(mac[offset + 3]);
    let modulo = 10u32.pow(digits);
    let code = bin % modulo;
    format!("{code:0width$}", width = digits as usize)
}

/// TOTP at an explicit unix timestamp (RFC 6238). T0 = 0.
pub fn totp_at(
    secret_b32: &str,
    unix_seconds: u64,
    period: u32,
    digits: u32,
) -> Result<String, CoreError> {
    if period == 0 {
        return Err(CoreError::Invalid("period must be >= 1".into()));
    }
    if !(6..=10).contains(&digits) {
        return Err(CoreError::Invalid("digits must be in 6..=10".into()));
    }
    let secret = base32_decode(secret_b32)?;
    if secret.is_empty() {
        return Err(CoreError::Invalid("empty TOTP secret".into()));
    }
    let counter = unix_seconds / period as u64;
    Ok(hotp(&secret, counter, digits))
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 Appendix B vectors use the ASCII seed "12345678901234567890".
    // Base32 of that ASCII string:
    const SEED_B32: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn rfc6238_sha1_known_vectors() {
        // (time, expected 8-digit code) for SHA-1, period 30. From RFC 6238 App. B.
        let cases = [
            (59u64, "94287082"),
            (1111111109u64, "07081804"),
            (1111111111u64, "14050471"),
            (1234567890u64, "89005924"),
            (2000000000u64, "69279037"),
            (20000000000u64, "65353130"),
        ];
        for (t, expected) in cases {
            let code = totp_at(SEED_B32, t, 30, 8).unwrap();
            assert_eq!(code, expected, "TOTP mismatch at t={t}");
        }
    }

    #[test]
    fn rejects_bad_digits_and_period() {
        assert!(totp_at(SEED_B32, 0, 0, 6).is_err());
        assert!(totp_at(SEED_B32, 0, 30, 5).is_err());
        assert!(totp_at(SEED_B32, 0, 30, 11).is_err());
    }

    #[test]
    fn six_digit_default() {
        let code = totp_at(SEED_B32, 59, 30, 6).unwrap();
        assert_eq!(code.len(), 6);
        // 8-digit was 94287082 -> last 6 digits.
        assert_eq!(code, "287082");
    }
}
