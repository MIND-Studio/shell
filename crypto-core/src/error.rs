//! Error type for the crypto core. Messages are intentionally generic for
//! crypto failures — never leak which step failed in a way that aids attacks,
//! and never embed secret material.

use core::fmt;

#[derive(Debug)]
pub enum CoreError {
    Kdf(String),
    /// AEAD seal/open failure (tag mismatch, wrong key, tamper). Generic on open.
    Aead(&'static str),
    /// Bad base64 / malformed input from JS.
    Encoding(String),
    /// Unknown / locked session handle.
    Session(&'static str),
    /// Invalid argument (lengths, options, etc).
    Invalid(String),
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::Kdf(m) => write!(f, "kdf error: {m}"),
            CoreError::Aead(m) => write!(f, "aead error: {m}"),
            CoreError::Encoding(m) => write!(f, "encoding error: {m}"),
            CoreError::Session(m) => write!(f, "session error: {m}"),
            CoreError::Invalid(m) => write!(f, "invalid argument: {m}"),
        }
    }
}

impl std::error::Error for CoreError {}
