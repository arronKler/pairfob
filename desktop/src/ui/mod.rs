//! The GPUI layer: one window, a session list, the terminal surface, and the
//! first-run and pairing screens. Everything below it is GPUI-free.

mod agent_marks;
mod agent_marks_data;
mod boot;
mod canvas_paint;
mod chat;
mod chat_entries;
mod chat_input;
mod chat_view;
mod commands;
mod controls;
mod devices;
mod find;
mod geometry;
mod glyphs;
mod input;
mod layout;
mod lifecycle;
mod menu;
mod pairing;
mod pairing_view;
mod rename;
mod selection;
mod sessions;
mod sidebar;
mod slide;
mod terminal;
mod theme;
mod update;
mod view;
mod window;

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{px, size, App, AppContext, TitlebarOptions, WindowBounds, WindowOptions};

use crate::herdr::Desktop;

/// Opens the window and runs until the last one closes. The error is carried
/// out of GPUI's callback because the platform run loop does not return one.
/// `session` is the Herdr session the engine attached to, so the startup check
/// looks for that session's socket rather than the default one.
pub fn run(desktop: Desktop, session: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let failure = Rc::new(RefCell::new(None::<String>));
    let slot = Rc::clone(&failure);
    #[cfg(feature = "shot")]
    let shot = std::env::var_os("PF_DESKTOP_SHOT").map(std::path::PathBuf::from);
    gpui_platform::application().run(move |cx| match open(desktop, session, cx) {
        Ok(handle) => {
            #[cfg(feature = "shot")]
            if let Some(path) = shot {
                spawn_shot(cx, handle, path);
            }
            #[cfg(not(feature = "shot"))]
            let _ = handle;
        }
        Err(error) => *slot.borrow_mut() = Some(error.to_string()),
    });
    let message = Rc::try_unwrap(failure)
        .ok()
        .and_then(|slot| slot.into_inner());
    match message {
        Some(error) => Err(error.into()),
        None => Ok(()),
    }
}

/// `cargo run --features shot`, with `PF_DESKTOP_SHOT=/tmp/window.png`, renders
/// the live window to a file instead of relying on the screen recorder.
#[cfg(feature = "shot")]
fn spawn_shot(cx: &mut App, handle: gpui::AnyWindowHandle, out: std::path::PathBuf) {
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(std::time::Duration::from_secs(4))
            .await;
        // `render_to_image` paints the last committed scene. macOS only commits
        // a scene from the display link, which does not run while the window is
        // occluded (a capture launched from a terminal usually is), so draw one
        // frame here instead of writing whatever was on screen at launch.
        let result = handle.update(cx, |_, window, cx| {
            let _ = window.draw(cx);
            window.render_to_image()
        });
        match result {
            Ok(Ok(image)) => match image.save(&out) {
                Ok(()) => eprintln!("shot: wrote {}", out.display()),
                Err(error) => eprintln!("shot: could not write {}: {error}", out.display()),
            },
            Ok(Err(error)) => eprintln!("shot: {error}"),
            Err(error) => eprintln!("shot: the window went away: {error}"),
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

/// `PF_DESKTOP_SHOT_SIZE=820x900` renders at that size instead of the
/// remembered one, so the narrow layout can be checked without moving the
/// user's window.
#[cfg(feature = "shot")]
fn shot_bounds(bounds: gpui::Bounds<gpui::Pixels>) -> gpui::Bounds<gpui::Pixels> {
    let Some((width, height)) = std::env::var("PF_DESKTOP_SHOT_SIZE")
        .ok()
        .and_then(|raw| {
            raw.split_once('x')
                .map(|(w, h)| (w.to_owned(), h.to_owned()))
        })
        .and_then(|(w, h)| Some((w.parse::<f32>().ok()?, h.parse::<f32>().ok()?)))
    else {
        return bounds;
    };
    gpui::Bounds::new(bounds.origin, size(px(width), px(height)))
}

#[cfg(not(feature = "shot"))]
fn shot_bounds(bounds: gpui::Bounds<gpui::Pixels>) -> gpui::Bounds<gpui::Pixels> {
    bounds
}

fn open(
    desktop: Desktop,
    session: Option<String>,
    cx: &mut App,
) -> Result<gpui::AnyWindowHandle, Box<dyn std::error::Error>> {
    let saved = geometry::Saved::load();
    let bounds = shot_bounds(saved.bounds(cx));
    let window = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(720.), px(520.))),
                // The window draws its own top band, so the titlebar is
                // transparent and the traffic lights sit inside the sidebar's
                // drag strip. AppKit does not drag from a titlebar the app owns;
                // the strip calls `start_window_move` instead.
                app_owns_titlebar_drag: true,
                // AppKit's own border does the resizing; GPUI implements
                // `start_window_resize` only on Windows and X11.
                is_resizable: true,
                titlebar: Some(TitlebarOptions {
                    title: Some("Pairfob".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(gpui::point(px(16.), px(12.))),
                }),
                app_id: Some("com.pairfob.desktop".into()),
                ..Default::default()
            },
            move |window, cx| cx.new(|cx| window::PairfobWindow::new(desktop, session, window, cx)),
        )
        .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
    Ok(window.into())
}
