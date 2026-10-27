fn main() {
    // 让图标变更也能触发重编译。
    // tauri-build 的 rerun-if-changed 只覆盖 tauri.conf.json / dist / Info.plist / capabilities，
    // 不覆盖 icons/ —— 不补这一行，`pnpm icon` 换完图标 cargo 不会重建，
    // 产物里（以及 macOS 应用包里）还是旧图标。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
