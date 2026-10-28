//! Native window messages which WebView focus events do not reliably cover.
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri::Manager;
static TRAY_ACTIVATIONS: AtomicUsize = AtomicUsize::new(0);
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
static SESSION_PAUSED: AtomicBool = AtomicBool::new(false);
static WINDOW_VISIBLE: AtomicBool = AtomicBool::new(true);
static WINDOW_MINIMIZED: AtomicBool = AtomicBool::new(false);

const SUBCLASS_ID: usize = 0x585758;
const WM_NCDESTROY: u32 = 0x0082;
const SIZE_MINIMIZED: usize = 1;

type WindowProc = unsafe extern "system" fn(*mut c_void, u32, usize, isize, usize, usize) -> isize;

#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(window: *mut c_void, callback: WindowProc, id: usize, data: usize) -> i32;
    fn RemoveWindowSubclass(window: *mut c_void, callback: WindowProc, id: usize) -> i32;
    fn DefSubclassProc(window: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
}

#[link(name = "wtsapi32")]
extern "system" {
    fn WTSRegisterSessionNotification(window: *mut c_void, flags: u32) -> i32;
    fn WTSUnRegisterSessionNotification(window: *mut c_void) -> i32;
}

pub(crate) fn sync_activity(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        // WM_SHOWWINDOW/WM_SIZE arrive before Tao updates its cached flags.
        // Keep the native message state so a restored window cannot stay hidden.
        let visible =
            WINDOW_VISIBLE.load(Ordering::Acquire) && !WINDOW_MINIMIZED.load(Ordering::Acquire);
        let foreground = unsafe { GetForegroundWindow() };
        let active = visible
            && !SESSION_PAUSED.load(Ordering::Acquire)
            && !foreground.is_null()
            && main.hwnd().is_ok_and(|handle| handle.0 == foreground);
        let _ = main.eval(format!("document.documentElement.dataset.nativeWindowActive='{active}';document.documentElement.dataset.nativeWindowVisible='{visible}';window.dispatchEvent(new Event('xwx:native-window-focus'))"));
        // Keep scripts, state notifications and in-flight saves alive while
        // allowing WebView2 to discard background caches. Restore before use.
        let _ = main.with_webview(move |webview| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            };
            use windows_core::Interface;
            if let Ok(view) = webview
                .controller()
                .CoreWebView2()
                .and_then(|view| view.cast::<ICoreWebView2_19>())
            {
                let _ = view.SetMemoryUsageTargetLevel(if active {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                });
            }
        });
    }
}

fn session_availability(message: u32, wparam: usize) -> Option<bool> {
    if message != 0x02b1 {
        return None;
    }
    match wparam {
        2 | 4 | 6 | 7 => Some(false),     // disconnect, logoff, lock
        1 | 3 | 5 | 8 | 15 => Some(true), // connect, logon, unlock, desktop ready
        _ => None,
    }
}

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> *mut c_void;
    fn IsWindowVisible(window: *mut c_void) -> i32;
    fn IsIconic(window: *mut c_void) -> i32;
    fn SetActiveWindow(window: *mut c_void) -> *mut c_void;
}

pub(crate) fn focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.set_focus().map_err(|error| error.to_string())?;
    let handle = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
    // SetForegroundWindow may be denied by Windows. Still transfer activation
    // within our own UI thread, then move focus into the selected WebView.
    window
        .run_on_main_thread(move || unsafe {
            SetActiveWindow(handle as *mut c_void);
        })
        .map_err(|error| error.to_string())?;
    let webview: &tauri::Webview = window.as_ref();
    webview.set_focus().map_err(|error| error.to_string())?;
    if window.label() == crate::windows_tray::LABEL {
        // ShowWindow may briefly activate the previous WebView. Arm dismissal
        // only after our native activation and content-focus messages ran.
        window
            .run_on_main_thread(crate::windows_tray::arm)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn focus_debug(window: &tauri::WebviewWindow) -> serde_json::Value {
    serde_json::json!({"foreground":unsafe {GetForegroundWindow()} as usize,
        "window":window.hwnd().map(|handle|handle.0 as usize).unwrap_or(0),
        "activations":TRAY_ACTIVATIONS.load(Ordering::Relaxed),"armed":crate::windows_tray::armed()})
}

fn tray_deactivated(is_tray: bool, message: u32, wparam: usize) -> bool {
    // WM_ACTIVATE / WA_INACTIVE refers to the top-level window. WebView2 may
    // retain keyboard focus in its child after this window is deactivated.
    is_tray && message == 0x0006 && wparam & 0xffff == 0
}

fn opens_system_menu(message: u32, wparam: usize, window: usize) -> bool {
    match message {
        // Mouse and Alt+Space entry points. Preserve every actual window command.
        0x0112 => matches!(wparam & 0xfff0, 0xf090 | 0xf100),
        // A right click on the caption or system icon must not reach DefWindowProc.
        0x00a4 | 0x00a5 => matches!(wparam, 2 | 3),
        // Tauri's draggable client caption can send WM_CONTEXTMENU directly.
        // Child WebView controls retain their own context-menu event handling.
        0x007b => wparam == window,
        _ => false,
    }
}

unsafe extern "system" fn window_proc(
    window: *mut c_void,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    data: usize,
) -> isize {
    if data == 1 && message == 0x0006 {
        TRAY_ACTIVATIONS.fetch_add(1, Ordering::Relaxed);
    }
    if tray_deactivated(data == 1, message, wparam) && crate::windows_tray::deactivated() {
        // Tauri must update its visibility flags too. Raw ShowWindow(SW_HIDE)
        // leaves Tao believing this window is visible, so the next show is lost.
        if let Some(app) = APP.get() {
            crate::windows_tray::hide(app);
        }
    }
    if data == 2 {
        if message == 0x0018 {
            WINDOW_VISIBLE.store(wparam != 0, Ordering::Release);
        }
        if message == 0x0005 {
            WINDOW_MINIMIZED.store(wparam == SIZE_MINIMIZED, Ordering::Release);
        }
        let session = session_availability(message, wparam);
        if let Some(available) = session {
            SESSION_PAUSED.store(!available, Ordering::Release);
        }
        if matches!(message, 0x0006 | 0x0018 | 0x0005) || session.is_some() {
            if let Some(app) = APP.get() {
                let target = app.clone();
                let _ = app.run_on_main_thread(move || sync_activity(&target));
            }
        }
    }
    if opens_system_menu(message, wparam, window as usize) {
        return 0;
    }
    if message == WM_NCDESTROY {
        if data == 2 {
            WTSUnRegisterSessionNotification(window);
        }
        RemoveWindowSubclass(window, window_proc, id);
    }
    DefSubclassProc(window, message, wparam, lparam)
}

pub(crate) fn attach(window: &tauri::Window) {
    APP.get_or_init(|| window.app_handle().clone());
    let kind = if window.label() == crate::windows_tray::LABEL {
        1
    } else if window.label() == "main" {
        2
    } else {
        0
    };
    // WebView-ready runs on the owning UI thread. Subclass only our Tauri window,
    // never the separate Windows file/folder dialog windows.
    match window.hwnd() {
        Ok(handle)
            if unsafe { SetWindowSubclass(handle.0.cast(), window_proc, SUBCLASS_ID, kind) }
                != 0 => {}
        Ok(_) => eprintln!("无法停用系统窗口菜单：{}", std::io::Error::last_os_error()),
        Err(error) => eprintln!("无法取得应用窗口：{error}"),
    }
    if kind == 2 {
        if let Ok(handle) = window.hwnd() {
            WINDOW_VISIBLE.store(
                unsafe { IsWindowVisible(handle.0.cast()) } != 0,
                Ordering::Release,
            );
            WINDOW_MINIMIZED.store(unsafe { IsIconic(handle.0.cast()) } != 0, Ordering::Release);
            if unsafe { WTSRegisterSessionNotification(handle.0.cast(), 0) } == 0 {
                eprintln!("无法订阅窗口会话状态：{}", std::io::Error::last_os_error());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_session_lifecycle_messages_change_animation_availability() {
        for value in [2, 4, 6, 7] {
            assert_eq!(session_availability(0x02b1, value), Some(false));
        }
        for value in [1, 3, 5, 8, 15] {
            assert_eq!(session_availability(0x02b1, value), Some(true));
        }
        assert_eq!(session_availability(0x02b1, 9), None);
        assert_eq!(session_availability(0x0006, 7), None);
    }

    #[test]
    fn only_tray_top_level_deactivation_dismisses_the_popup() {
        assert!(tray_deactivated(true, 0x0006, 0));
        assert!(tray_deactivated(true, 0x0006, 0x10000));
        for (tray, message, wparam) in [
            (false, 0x0006, 0),
            (true, 0x0006, 1),
            (true, 0x0006, 2),
            (true, 0x0008, 0),
            (true, 0x0007, 0),
        ] {
            assert!(!tray_deactivated(tray, message, wparam));
        }
    }

    #[test]
    fn caption_mouse_and_keyboard_menu_entry_points_are_blocked() {
        for (message, wparam) in [(0x0112, 0xf090), (0x0112, 0xf10f), (0x00a4, 2), (0x00a5, 3)] {
            assert!(opens_system_menu(message, wparam, 42));
        }
    }

    #[test]
    fn window_actions_and_client_context_events_remain_available() {
        for (message, wparam) in [
            (0x0112, 0xf060),
            (0x0112, 0xf020),
            (0x0112, 0xf030),
            (0x0112, 0xf120),
            (0x007b, 0),
            (0x00a5, 1),
            (WM_NCDESTROY, 0),
        ] {
            assert!(!opens_system_menu(message, wparam, 42));
        }
    }

    #[test]
    fn client_caption_context_menu_is_blocked_without_intercepting_child_controls() {
        assert!(opens_system_menu(0x007b, 42, 42));
        assert!(!opens_system_menu(0x007b, 43, 42));
    }
}
