// 发行版不弹出额外的控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod crypto;
mod ncm;
mod server;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub static ENABLE_DESKTOP_ISLAND: AtomicBool = AtomicBool::new(true);
pub static ISLAND_ALWAYS_ON_TOP: AtomicBool = AtomicBool::new(true);

pub fn update_island_config(enable: bool, always_on_top: bool) {
    ENABLE_DESKTOP_ISLAND.store(enable, Ordering::SeqCst);
    ISLAND_ALWAYS_ON_TOP.store(always_on_top, Ordering::SeqCst);
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.show();
        let _ = main_win.unminimize();
        let _ = main_win.set_focus();
    }
    if let Some(island_win) = app.get_webview_window("island") {
        let _ = island_win.hide();
    }
    Ok(())
}

#[tauri::command]
fn hide_desktop_island(app: AppHandle) -> Result<(), String> {
    if let Some(island_win) = app.get_webview_window("island") {
        let _ = island_win.hide();
    }
    Ok(())
}

#[tauri::command]
fn toggle_desktop_island(app: AppHandle, show: Option<bool>) -> Result<(), String> {
    if let Some(island_win) = app.get_webview_window("island") {
        let should_show = show.unwrap_or_else(|| !island_win.is_visible().unwrap_or(false));
        if should_show {
            let _ = island_win.show();
            let _ = island_win.set_always_on_top(ISLAND_ALWAYS_ON_TOP.load(Ordering::SeqCst));
            let _ = island_win.unminimize();
            if let Some(main_win) = app.get_webview_window("main") {
                let _ = main_win.hide();
            }
        } else {
            let _ = island_win.hide();
        }
    }
    Ok(())
}

#[tauri::command]
fn update_island_settings(app: AppHandle, enable: bool, always_on_top: bool) -> Result<(), String> {
    update_island_config(enable, always_on_top);
    if let Some(island_win) = app.get_webview_window("island") {
        let _ = island_win.set_always_on_top(always_on_top);
        if !enable {
            let _ = island_win.hide();
        }
    }
    Ok(())
}

/// 动态调整灵动岛窗口尺寸（待机 120x28 严丝合缝绝不挡周围，播放 186x28 紧凑胶囊，展开 284x74 小巧精致卡片）
#[tauri::command]
fn set_island_expanded(app: AppHandle, expanded: bool, playing: Option<bool>) -> Result<(), String> {
    if let Some(island_win) = app.get_webview_window("island") {
        let is_playing = playing.unwrap_or(false);
        let (w, h) = if expanded {
            (284.0, 74.0)
        } else if is_playing {
            (186.0, 28.0)
        } else {
            (120.0, 28.0)
        };
        let _ = island_win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
        if let Ok(Some(monitor)) = island_win.primary_monitor() {
            let scale = monitor.scale_factor();
            let screen_w = monitor.size().width as f64 / scale;
            let x = (screen_w - w) / 2.0;
            let _ = island_win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, 4.0)));
        }
    }
    Ok(())
}

/// 主窗口最小化到桌面灵动岛
#[tauri::command]
fn minimize_to_island(app: AppHandle) -> Result<(), String> {
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.minimize();
    }
    if ENABLE_DESKTOP_ISLAND.load(Ordering::SeqCst) {
        if let Some(island_win) = app.get_webview_window("island") {
            let _ = island_win.show();
            let _ = island_win.set_always_on_top(ISLAND_ALWAYS_ON_TOP.load(Ordering::SeqCst));
            let _ = island_win.unminimize();
        }
    }
    Ok(())
}

/// 鼠标穿透控制
#[tauri::command]
fn set_island_mouse_passthrough(app: AppHandle, passthrough: bool) -> Result<(), String> {
    if let Some(island_win) = app.get_webview_window("island") {
        let _ = island_win.set_ignore_cursor_events(passthrough);
    }
    Ok(())
}

/// 定位前端资源目录：安装后取资源目录，开发期取工程内 public/
fn resolve_public(app: &tauri::AppHandle) -> PathBuf {
    // 1) 环境变量显式覆盖
    if let Ok(p) = std::env::var("WENKU8_PUBLIC") {
        let p = PathBuf::from(p);
        if p.join("index.html").exists() {
            return p;
        }
    }

    // 2) 开发期优先用工程内 public/，避免命中 target/debug/public 的陈旧副本
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public");
    if cfg!(debug_assertions) && dev.join("index.html").exists() {
        return dev;
    }

    // 3) 安装后的资源目录
    if let Ok(rd) = app.path().resource_dir() {
        for sub in ["public", "_up_/public"] {
            let p = rd.join(sub);
            if p.join("index.html").exists() {
                return p;
            }
        }
    }

    // 4) 工程内的 public/
    if dev.join("index.html").exists() {
        return dev;
    }

    // 5) 可执行文件同级
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("public");
            if p.join("index.html").exists() {
                return p;
            }
        }
    }

    dev
}

/// 写入运行日志
fn log_info(msg: &str) {
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(local_app).join("Wenku8AudioArchive");
        let _ = std::fs::create_dir_all(&dir);
        let log_file = dir.join("app.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_file) {
            use std::io::Write;
            let _ = writeln!(f, "[wenku8] {}", msg);
        }
    }
}

/// Windows 原生单实例互斥量保护，防止多开造成 WebView2 目录文件锁冲突与端口抢占
#[cfg(windows)]
unsafe fn ensure_single_instance() -> bool {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(lpMutexAttributes: *mut std::ffi::c_void, bInitialOwner: i32, lpName: *const u16) -> *mut std::ffi::c_void;
        fn GetLastError() -> u32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> *mut std::ffi::c_void;
        fn ShowWindow(hWnd: *mut std::ffi::c_void, nCmdShow: i32) -> i32;
        fn SetForegroundWindow(hWnd: *mut std::ffi::c_void) -> i32;
    }

    let name: Vec<u16> = OsStr::new("Local\\Wenku8AudioArchive_SingleInstance_Mutex").encode_wide().chain(Some(0)).collect();
    let _handle = CreateMutexW(std::ptr::null_mut(), 1, name.as_ptr());
    const ERROR_ALREADY_EXISTS: u32 = 183;
    if GetLastError() == ERROR_ALREADY_EXISTS {
        // 已有实例在运行，尝试将已有实例的窗口唤起并置顶
        let win_title: Vec<u16> = OsStr::new("Wenku8 Audio Archive // 3D 立体白盒书架").encode_wide().chain(Some(0)).collect();
        let hwnd = FindWindowW(std::ptr::null(), win_title.as_ptr());
        if !hwnd.is_null() {
            ShowWindow(hwnd, 9); // 9 = SW_RESTORE
            SetForegroundWindow(hwnd);
        }
        // 向现有后台服务发送唤回主窗口命令
        if let Ok(mut stream) = std::net::TcpStream::connect("127.0.0.1:62983") {
            use std::io::Write;
            let req = b"GET /api/island/action?cmd=show_main HTTP/1.1\r\nHost: 127.0.0.1:62983\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(req);
        }
        return false; // 新实例退出
    }
    true
}

fn main() {
    // 1. 设置 Panic 崩溃日志钩子，确保排查透明
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("应用异常中断 (Panic): {}", info);
        log_info(&msg);
    }));

    // 2. Windows 单实例互斥量检查
    #[cfg(windows)]
    unsafe {
        if !ensure_single_instance() {
            // 已有实例在运行并已唤醒，当前进程安全退出，避免多开冲突
            return;
        }
    }

    log_info("启动 Wenku8AudioArchive 主进程...");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            show_main_window,
            hide_desktop_island,
            toggle_desktop_island,
            update_island_settings,
            set_island_expanded,
            minimize_to_island,
            set_island_mouse_passthrough
        ])
        .setup(|app| {
            let public = resolve_public(app.handle());
            log_info(&format!("前端静态目录解析结果: {}", public.display()));

            let app_handle = app.handle().clone();
            let port = server::start(public, Some(app_handle.clone()))
                .map_err(|e| {
                    log_info(&format!("启动内部本地微服务失败: {}", e));
                    e
                })?;
            log_info(&format!("内部 HTTP 服务已成功运行在端口: {}", port));

            let main_url: tauri::Url = format!("http://127.0.0.1:{}/index.html", port).parse()?;
            let island_url: tauri::Url = format!("http://127.0.0.1:{}/island.html", port).parse()?;

            // 1. 创建主播放器窗口 (确保显式可见并置于中心)
            let main_window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(main_url))
                .title("Wenku8 Audio Archive // 3D 立体白盒书架")
                .inner_size(1180.0, 780.0)
                .min_inner_size(460.0, 640.0)
                .center()
                .visible(true)
                .initialization_script(r#"
                    try {
                        if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
                            navigator.serviceWorker.getRegistrations().then(function (rs) {
                                rs.forEach(function (r) { r.unregister(); });
                            });
                        }
                        if (typeof window !== 'undefined' && window.caches) {
                            caches.keys().then(function (ks) {
                                ks.forEach(function (k) { caches.delete(k); });
                            });
                        }
                    } catch (_) {}
                "#)
                .build()?;

            let _ = main_window.show();
            let _ = main_window.unminimize();
            let _ = main_window.set_focus();
            log_info("主播放器窗口已成功创建并显示");

            // 2. 创建桌面悬浮灵动岛窗口 (透明无边框、置顶、跳过任务栏、无阴影、初始贴合胶囊 120x28 绝不挡周围)
            let island_builder = WebviewWindowBuilder::new(app, "island", WebviewUrl::External(island_url))
                .title("Wenku8 Desktop Island")
                .inner_size(120.0, 28.0)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .visible(false);

            if let Ok(island_win) = island_builder.build() {
                if let Ok(Some(monitor)) = island_win.primary_monitor() {
                    let scale = monitor.scale_factor();
                    let screen_w = monitor.size().width as f64 / scale;
                    let x = (screen_w - 120.0) / 2.0;
                    let _ = island_win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, 4.0)));
                }
                log_info("桌面灵动岛窗口就绪 (120x28 极致贴合小胶囊)");
            }

            // 3. 构造系统托盘图标 (System Tray)，提供无缝桌面集成
            let show_item = MenuItem::with_id(app, "show", "打开播放器主界面", true, None::<&str>)?;
            let island_item = MenuItem::with_id(app, "toggle_island", "显示/隐藏桌面灵动岛", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出播放器", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &island_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("Wenku8 Audio Archive 音乐典藏")
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            let _ = show_main_window(app.clone());
                        }
                        "toggle_island" => {
                            let _ = toggle_desktop_island(app.clone(), None);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        let _ = show_main_window(app.clone());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            if let Err(e) = tray_builder.build(app) {
                log_info(&format!("系统托盘注册提示: {}", e));
            } else {
                log_info("系统托盘图标已成功挂载");
            }

            // 4. 拦截主窗口事件：
            // a) 点击关闭 X -> 拦截并收缩至桌面灵动岛
            // b) 缩小化（最小化） -> 同步唤起桌面灵动岛悬浮
            let app_clone = app_handle.clone();
            main_window.on_window_event(move |event| {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        if ENABLE_DESKTOP_ISLAND.load(Ordering::SeqCst) {
                            api.prevent_close();
                            if let Some(main_win) = app_clone.get_webview_window("main") {
                                let _ = main_win.hide();
                            }
                            if let Some(island_win) = app_clone.get_webview_window("island") {
                                let _ = island_win.show();
                                let _ = island_win.set_always_on_top(ISLAND_ALWAYS_ON_TOP.load(Ordering::SeqCst));
                                let _ = island_win.unminimize();
                            }
                        }
                    }
                    WindowEvent::Resized(_) | WindowEvent::Focused(_) => {
                        if let Some(main_win) = app_clone.get_webview_window("main") {
                            if main_win.is_minimized().unwrap_or(false) {
                                if ENABLE_DESKTOP_ISLAND.load(Ordering::SeqCst) {
                                    if let Some(island_win) = app_clone.get_webview_window("island") {
                                        let _ = island_win.show();
                                        let _ = island_win.set_always_on_top(ISLAND_ALWAYS_ON_TOP.load(Ordering::SeqCst));
                                        let _ = island_win.unminimize();
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
