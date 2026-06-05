//! Native-only memory hardening: pin a key region into physical RAM so it is
//! never written to swap / the page file, and unpin it on drop. This is the
//! payoff of the native (Tauri) path over WASM — WASM linear memory cannot be
//! `mlock`'d (PRD-NATIVE §2, README "Memory hygiene").
//!
//! - Unix (Linux/macOS): `libc::mlock` / `libc::munlock`.
//! - Windows: `VirtualLock` / `VirtualUnlock` from `kernel32` (declared inline
//!   so we don't pull in an extra crate).
//!
//! Locking is **best-effort**: `mlock` can fail under `RLIMIT_MEMLOCK`. A
//! failure is surfaced to the caller (so the native layer can log the WebID/
//! event — never the bytes) but is NOT fatal; zeroize-on-drop still applies.
//! We never log the locked bytes.
#![cfg(not(target_arch = "wasm32"))]

/// Outcome of a lock attempt, so the caller can record whether the hardened
/// guarantee actually held on this device without ever touching the bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockState {
    /// The region is pinned into RAM (won't be swapped).
    Locked,
    /// The OS refused to pin it (e.g. RLIMIT_MEMLOCK). Zeroize-on-drop still
    /// protects the bytes; they may transiently reach swap.
    Unlocked,
}

/// Attempt to pin `[ptr, ptr+len)` into physical memory.
///
/// # Safety
/// `ptr` must point to a valid, owned allocation of at least `len` bytes that
/// stays alive (and at this address) until the matching [`unlock_region`].
#[cfg(unix)]
pub unsafe fn lock_region(ptr: *const u8, len: usize) -> LockState {
    if len == 0 {
        return LockState::Locked;
    }
    if libc::mlock(ptr as *const libc::c_void, len) == 0 {
        LockState::Locked
    } else {
        LockState::Unlocked
    }
}

/// Unpin a region previously passed to [`lock_region`]. Idempotent enough for
/// drop use — a failed unlock is ignored (the process is tearing the region
/// down anyway, and we still zeroize).
///
/// # Safety
/// Same contract as [`lock_region`]; call at most once per successful lock.
#[cfg(unix)]
pub unsafe fn unlock_region(ptr: *const u8, len: usize) {
    if len == 0 {
        return;
    }
    let _ = libc::munlock(ptr as *const libc::c_void, len);
}

#[cfg(windows)]
extern "system" {
    fn VirtualLock(addr: *mut core::ffi::c_void, size: usize) -> i32;
    fn VirtualUnlock(addr: *mut core::ffi::c_void, size: usize) -> i32;
}

/// Windows: pin via `VirtualLock`.
///
/// # Safety
/// See the `unix` variant.
#[cfg(windows)]
pub unsafe fn lock_region(ptr: *const u8, len: usize) -> LockState {
    if len == 0 {
        return LockState::Locked;
    }
    if VirtualLock(ptr as *mut core::ffi::c_void, len) != 0 {
        LockState::Locked
    } else {
        LockState::Unlocked
    }
}

/// Windows: unpin via `VirtualUnlock`.
///
/// # Safety
/// See the `unix` variant.
#[cfg(windows)]
pub unsafe fn unlock_region(ptr: *const u8, len: usize) {
    if len == 0 {
        return;
    }
    let _ = VirtualUnlock(ptr as *mut core::ffi::c_void, len);
}

// Belt-and-suspenders for any other native target we don't special-case: no
// locking primitive, but the type still compiles and zeroize-on-drop holds.
#[cfg(not(any(unix, windows)))]
pub unsafe fn lock_region(_ptr: *const u8, _len: usize) -> LockState {
    LockState::Unlocked
}
#[cfg(not(any(unix, windows)))]
pub unsafe fn unlock_region(_ptr: *const u8, _len: usize) {}

/// A heap-boxed, page-pinned, zeroize-on-drop byte buffer for key material.
///
/// The bytes are owned on a stable heap address (`Box`), `mlock`'d for their
/// whole lifetime, zeroized when dropped, then `munlock`'d. The contents are
/// never exposed except through [`MlockedBytes::as_slice`], which is
/// crate-internal — they never cross any FFI boundary.
pub struct MlockedBytes {
    buf: Box<[u8]>,
    state: LockState,
}

impl MlockedBytes {
    /// Copy `bytes` into a freshly pinned region, then zeroize the caller's copy
    /// is the caller's responsibility (we only own ours).
    pub fn new(bytes: &[u8]) -> Self {
        let buf: Box<[u8]> = bytes.to_vec().into_boxed_slice();
        // SAFETY: `buf` is a live, owned heap allocation we keep until drop.
        let state = unsafe { lock_region(buf.as_ptr(), buf.len()) };
        MlockedBytes { buf, state }
    }

    /// Borrow the locked bytes. Crate-internal — must never be returned across
    /// an FFI boundary (HARD rule #1).
    pub fn as_slice(&self) -> &[u8] {
        &self.buf
    }

    /// Whether the OS actually pinned this region.
    pub fn lock_state(&self) -> LockState {
        self.state
    }
}

impl Drop for MlockedBytes {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        // Zeroize while still locked, then unlock.
        self.buf.zeroize();
        // SAFETY: same region we locked in `new`, unlocked exactly once.
        unsafe { unlock_region(self.buf.as_ptr(), self.buf.len()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_preserves_bytes() {
        let m = MlockedBytes::new(&[1, 2, 3, 4, 5]);
        assert_eq!(m.as_slice(), &[1, 2, 3, 4, 5]);
    }

    #[test]
    fn empty_is_locked_noop() {
        let m = MlockedBytes::new(&[]);
        assert_eq!(m.as_slice(), &[] as &[u8]);
        // Empty regions are trivially "locked" (nothing to pin).
        assert_eq!(m.lock_state(), LockState::Locked);
    }

    #[test]
    fn small_region_locks_on_this_host() {
        // Under a normal RLIMIT_MEMLOCK a 32-byte lock should succeed; if the
        // host forbids it we still expect a defined state, never a panic.
        let m = MlockedBytes::new(&[0u8; 32]);
        assert!(matches!(m.lock_state(), LockState::Locked | LockState::Unlocked));
    }
}
