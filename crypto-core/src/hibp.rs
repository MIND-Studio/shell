//! Have I Been Pwned k-anonymity helper (PRD §4.1). SHA-1 the password locally,
//! return the 5-hex-char prefix (sent to the HIBP range API) and the remaining
//! 35-char suffix (compared locally against the range response). The password
//! and full hash NEVER leave the device.

use sha1::{Digest, Sha1};

/// Result of `hibp_prefix`. Mirrors `HibpPrefix` in the FFI contract.
pub struct HibpPrefix {
    pub prefix: String,
    pub suffix: String,
}

/// SHA-1(password) -> uppercase hex, split into a 5-char prefix and 35-char
/// suffix.
pub fn hibp_prefix(password: &str) -> HibpPrefix {
    let digest = Sha1::digest(password.as_bytes());
    let hex = hex_upper(&digest);
    let (prefix, suffix) = hex.split_at(5);
    HibpPrefix {
        prefix: prefix.to_string(),
        suffix: suffix.to_string(),
    }
}

fn hex_upper(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_sha1_split() {
        // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
        let r = hibp_prefix("password");
        assert_eq!(r.prefix, "5BAA6");
        assert_eq!(r.suffix, "1E4C9B93F3F0682250B6CF8331B7EE68FD8");
        assert_eq!(r.prefix.len() + r.suffix.len(), 40);
    }

    #[test]
    fn prefix_is_5_chars() {
        let r = hibp_prefix("any other password");
        assert_eq!(r.prefix.len(), 5);
        assert_eq!(r.suffix.len(), 35);
    }
}
