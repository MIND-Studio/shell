// Desktop launcher. All app logic lives in the library crate so the same code
// builds for iOS/Android (their harnesses call `mind_shell_lib::run()` directly).
// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mind_shell_lib::run();
}
