// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Older WebKitGTK builds abort at startup with
    // "Failed to create EGL display ... EGL_BAD_PARAMETER" when accelerated
    // compositing or the DMABUF renderer hits an unsupported GPU/driver. Force the
    // software fallback paths unless the user has already set these themselves.
    // (Must run before the webview is created.)
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    anvil_lib::run()
}
