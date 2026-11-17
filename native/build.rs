fn main() {
    napi_build::setup();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rustc-link-lib=framework=AppKit");
        // Xcode 27's linker can leave the symbol-name table 4 bytes off the 8-byte alignment dyld
        // requires ("mis-aligned LINKEDIT string pool"); the chained-fixups format lays it out correctly.
        println!("cargo:rustc-cdylib-link-arg=-Wl,-fixup_chains");
        // That's not enough when the import table has an odd number of entries (ld 27106.1, 2026-11-17):
        // scripts/native.mjs then rebuilds with `--cfg dunebot_pad`, which adds one (lib.rs).
    }
    println!("cargo:rustc-check-cfg=cfg(dunebot_pad)");
}
