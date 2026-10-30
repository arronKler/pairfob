//! The devices drawer: who is paired to this computer, how to reach them, and
//! the one place the window can unpair one. The listing and revoke calls run on
//! worker threads; the window only polls them.

use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::{unbounded, Receiver, Sender, TryRecvError};
use gpui::prelude::*;
use gpui::{div, px, AnyElement, Context, FontWeight, MouseDownEvent, SharedString, Window};

use crate::devices::{self, Device};
use crate::terminal::Rgb;

use super::controls::{button, dot, small_button, ButtonKind};
use super::layout;
use super::theme::{tone, Chrome};
use super::window::PairfobWindow;

const REFRESH: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DevicesList {
    Loading,
    Ready(Vec<Device>),
    Failed(String),
}

pub(crate) enum DeviceEvent {
    Listed(Result<Vec<Device>, String>),
    Revoked {
        id: String,
        result: Result<(), String>,
    },
}

pub(crate) struct DevicesSheet {
    pairfob: PathBuf,
    pub list: DevicesList,
    pub confirm: Option<String>,
    pub busy: Option<String>,
    pub action_error: Option<String>,
    /// The shot fixture shows invented rows and must never start a real CLI
    /// request, so it turns polling off.
    polling: bool,
    in_flight: bool,
    last_request: Option<Instant>,
    events: Receiver<DeviceEvent>,
    tx: Sender<DeviceEvent>,
}

impl DevicesSheet {
    pub fn start(pairfob: PathBuf) -> Self {
        let (tx, events) = unbounded();
        Self {
            pairfob,
            list: DevicesList::Loading,
            confirm: None,
            busy: None,
            action_error: None,
            polling: true,
            in_flight: false,
            last_request: None,
            events,
            tx,
        }
    }

    /// Three invented rows for the shot build: connected, known offline, and
    /// unknown (a daemon that predates the field). It never polls.
    #[cfg(any(test, feature = "shot"))]
    pub fn fixture() -> Self {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|delta| delta.as_secs() as i64)
            .unwrap_or(0);
        fn device(
            id: &str,
            label: &str,
            created: i64,
            last_seen: i64,
            connected: Option<bool>,
        ) -> Device {
            Device {
                id: id.to_owned(),
                label: label.to_owned(),
                created,
                last_seen,
                connected,
            }
        }
        let (tx, events) = unbounded();
        Self {
            pairfob: PathBuf::new(),
            list: DevicesList::Ready(vec![
                device(
                    "dev_fixture_phone",
                    "iPhone",
                    now - 2 * 24 * 60 * 60,
                    now - 30,
                    Some(true),
                ),
                device(
                    "dev_fixture_tablet",
                    "iPad",
                    now - 9 * 24 * 60 * 60,
                    now - 3 * 60 * 60,
                    Some(false),
                ),
                device(
                    "dev_fixture_android",
                    "Pixel",
                    now - 30 * 24 * 60 * 60,
                    0,
                    None,
                ),
            ]),
            confirm: None,
            busy: None,
            action_error: None,
            polling: false,
            in_flight: false,
            last_request: None,
            events,
            tx,
        }
    }

    /// Returns whether anything on screen changed. A request starts on the
    /// first poll and then at most once every [`REFRESH`].
    pub fn poll(&mut self, now: Instant) -> bool {
        let mut changed = false;
        let mut force = false;
        loop {
            match self.events.try_recv() {
                Ok(event) => {
                    changed = true;
                    match event {
                        DeviceEvent::Listed(result) => {
                            self.in_flight = false;
                            self.list = match result {
                                Ok(mut rows) => {
                                    devices::sort(&mut rows);
                                    DevicesList::Ready(rows)
                                }
                                Err(error) => DevicesList::Failed(error),
                            };
                        }
                        DeviceEvent::Revoked { id, result } => {
                            if self.busy.as_deref() == Some(id.as_str()) {
                                self.busy = None;
                            }
                            match result {
                                Ok(()) => {
                                    self.action_error = None;
                                    force = true;
                                }
                                Err(error) => self.action_error = Some(error),
                            }
                        }
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }
        if force {
            // A successful unpair makes the current rows stale; do not wait
            // out the refresh interval before listing again.
            self.last_request = None;
        }
        if self.polling
            && !self.in_flight
            && self
                .last_request
                .is_none_or(|last| now.saturating_duration_since(last) >= REFRESH)
        {
            self.refresh();
        }
        changed
    }

    pub fn refresh(&mut self) -> bool {
        if !self.polling || self.in_flight {
            return false;
        }
        self.in_flight = true;
        self.last_request = Some(Instant::now());
        let pairfob = self.pairfob.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            let _ = tx.send(DeviceEvent::Listed(devices::list(&pairfob)));
        });
        false
    }

    pub fn revoke(&mut self, id: String) -> bool {
        if self.busy.is_some() {
            return false;
        }
        self.confirm = None;
        self.busy = Some(id.clone());
        let pairfob = self.pairfob.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            let result = devices::revoke(&pairfob, &id);
            let _ = tx.send(DeviceEvent::Revoked { id, result });
        });
        true
    }
}

impl PairfobWindow {
    pub(crate) fn devices_drawer(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let sheet = self.devices.as_ref()?;
        let chrome = self.chrome.clone();
        let viewport = f32::from(window.viewport_size().width);
        let width =
            (viewport - layout::sidebar_width(self.sidebar_width, self.sidebar_collapsed) - 56.)
                .clamp(320., 620.);
        let action_error = sheet.action_error.clone();
        let confirm = sheet.confirm.clone();
        let busy = sheet.busy.clone();

        let mut body = div()
            .id("devices-body")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.devices_scroll)
            .p(px(12.))
            .gap(px(8.));

        if let Some(error) = action_error {
            body = body.child(line(error, chrome.danger, 11.5));
        }

        match &sheet.list {
            DevicesList::Loading => {
                body = body.child(line("Loading devices…".to_owned(), chrome.muted, 12.));
            }
            DevicesList::Failed(error) => {
                body = body.child(line(error.clone(), chrome.danger, 12.));
            }
            DevicesList::Ready(rows) if rows.is_empty() => {
                body = body.child(line(
                    "Nothing paired yet.".to_owned(),
                    chrome.foreground,
                    13.,
                ));
                body = body.child(line(
                    "Pair a phone or tablet to reach this computer.".to_owned(),
                    chrome.muted,
                    12.,
                ));
            }
            DevicesList::Ready(rows) => {
                for (index, device) in rows.iter().enumerate() {
                    body = body.child(device_row(
                        index,
                        device,
                        confirm.as_deref(),
                        busy.as_deref(),
                        &chrome,
                        cx,
                    ));
                }
            }
        }

        let close = small_button(
            "devices-close",
            "Close",
            &chrome,
            ButtonKind::Quiet,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.close_devices(cx)),
        );
        let pair = button(
            "devices-pair",
            "Pair a device",
            &chrome,
            ButtonKind::Primary,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.open_pairing(cx)),
        );

        Some(
            div()
                .absolute()
                .top(px(layout::TOOLBAR_HEIGHT + 10.))
                .right(px(14.))
                .bottom(px(14.))
                .w(px(width))
                .flex()
                .flex_col()
                .rounded(px(layout::RADIUS_CARD))
                .bg(tone(chrome.card))
                .border(px(1.))
                .border_color(tone(chrome.line))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .h(px(46.))
                        .px(px(14.))
                        .flex_none()
                        .border_b(px(1.))
                        .border_color(tone(chrome.line_soft))
                        .child(
                            div()
                                .flex_1()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(tone(chrome.foreground))
                                .child("Devices"),
                        )
                        .child(close),
                )
                .child(body)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .px(px(12.))
                        .py(px(10.))
                        .flex_none()
                        .border_t(px(1.))
                        .border_color(tone(chrome.line_soft))
                        .child(pair)
                        .child(div().flex_1())
                        .child(
                            div()
                                .text_size(px(10.5))
                                .text_color(tone(chrome.muted))
                                .child("Updates every 3 seconds"),
                        ),
                )
                .into_any_element(),
        )
    }

    pub(crate) fn confirm_device(&mut self, id: String, cx: &mut Context<Self>) {
        if let Some(sheet) = self.devices.as_mut() {
            sheet.confirm = Some(id);
            cx.notify();
        }
    }

    pub(crate) fn cancel_device_confirm(&mut self, cx: &mut Context<Self>) {
        if let Some(sheet) = self.devices.as_mut() {
            if sheet.confirm.take().is_some() {
                cx.notify();
            }
        }
    }

    pub(crate) fn unpair_device(&mut self, id: String, cx: &mut Context<Self>) {
        if let Some(sheet) = self.devices.as_mut() {
            if sheet.revoke(id) {
                cx.notify();
            }
        }
    }
}

fn device_row(
    index: usize,
    device: &Device,
    confirm: Option<&str>,
    busy: Option<&str>,
    chrome: &Chrome,
    cx: &mut Context<PairfobWindow>,
) -> AnyElement {
    let id = device.id.clone();
    let label = if device.label.trim().is_empty() {
        "Device".to_owned()
    } else {
        device.label.clone()
    };
    let now = SystemTime::now();
    let state = format!(
        "{} · {}",
        devices::last_seen_phrase(device.last_seen, device.connected, now),
        devices::paired_phrase(device.created, now)
    );
    let confirming = confirm == Some(device.id.as_str());
    let working = busy == Some(device.id.as_str());

    let mut heading = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(dot(
            tone(if device.is_connected() {
                chrome.success
            } else {
                chrome.muted
            }),
            7.,
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(13.))
                .text_color(tone(chrome.foreground))
                .child(SharedString::from(label.clone())),
        );
    if working {
        heading = heading.child(
            div()
                .text_size(px(11.))
                .text_color(tone(chrome.muted))
                .child("Unpairing…"),
        );
    } else if !confirming {
        heading = heading.child(small_button(
            ("device-unpair", index),
            "Unpair",
            chrome,
            ButtonKind::Quiet,
            cx.listener({
                let id = id.clone();
                move |this, _: &MouseDownEvent, _window, cx| this.confirm_device(id.clone(), cx)
            }),
        ));
    }

    let mut row = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .p(px(10.))
        .rounded(px(8.))
        .bg(tone(chrome.raised))
        .child(heading)
        .child(
            div()
                .text_size(px(11.5))
                .text_color(tone(chrome.muted))
                .child(SharedString::from(state)),
        );
    if confirming {
        row = row.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(11.5))
                        .text_color(tone(chrome.secondary))
                        .child(SharedString::from(format!(
                            "Unpair \"{label}\"? It must pair again to reconnect."
                        ))),
                )
                .child(small_button(
                    ("device-confirm", index),
                    "Unpair",
                    chrome,
                    ButtonKind::Danger,
                    cx.listener({
                        let id = id.clone();
                        move |this, _: &MouseDownEvent, _window, cx| {
                            this.unpair_device(id.clone(), cx)
                        }
                    }),
                ))
                .child(small_button(
                    ("device-cancel", index),
                    "Cancel",
                    chrome,
                    ButtonKind::Bordered,
                    cx.listener(|this, _: &MouseDownEvent, _window, cx| {
                        this.cancel_device_confirm(cx)
                    }),
                )),
        );
    }
    row.into_any_element()
}

fn line(text: String, color: Rgb, size: f32) -> AnyElement {
    div()
        .text_size(px(size))
        .text_color(tone(color))
        .child(SharedString::from(text))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(
        in_flight: bool,
        last_request: Option<Instant>,
    ) -> (DevicesSheet, Sender<DeviceEvent>) {
        let (tx, events) = unbounded();
        let out = tx.clone();
        (
            DevicesSheet {
                pairfob: PathBuf::from("/nonexistent/pairfob"),
                list: DevicesList::Loading,
                confirm: None,
                busy: None,
                action_error: None,
                polling: true,
                in_flight,
                last_request,
                events,
                tx,
            },
            out,
        )
    }

    fn device(id: &str, connected: Option<bool>) -> Device {
        Device {
            id: id.to_owned(),
            label: id.to_owned(),
            created: 1,
            last_seen: 2,
            connected,
        }
    }

    #[test]
    fn a_listed_event_fills_the_drawer_and_ends_the_request() {
        let now = Instant::now();
        let (mut sheet, out) = sheet(true, Some(now));
        out.send(DeviceEvent::Listed(Ok(vec![device("dev_a", Some(true))])))
            .unwrap();
        assert!(sheet.poll(now));
        assert!(!sheet.in_flight);
        match &sheet.list {
            DevicesList::Ready(rows) => {
                assert_eq!(rows.len(), 1);
                assert!(rows[0].is_connected());
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn a_failed_list_is_shown_without_repeating_the_request() {
        let now = Instant::now();
        let (mut sheet, out) = sheet(true, Some(now));
        out.send(DeviceEvent::Listed(Err("not running".to_owned())))
            .unwrap();
        assert!(sheet.poll(now));
        assert!(!sheet.in_flight);
        assert_eq!(sheet.list, DevicesList::Failed("not running".to_owned()));
    }

    #[test]
    fn a_successful_unpair_clears_busy_and_lists_again() {
        let now = Instant::now();
        let (mut sheet, out) = sheet(false, Some(now));
        sheet.busy = Some("dev_a".to_owned());
        out.send(DeviceEvent::Revoked {
            id: "dev_a".to_owned(),
            result: Ok(()),
        })
        .unwrap();
        assert!(sheet.poll(now));
        assert_eq!(sheet.busy, None);
        assert!(
            sheet.in_flight,
            "a successful unpair forces a fresh listing"
        );
    }

    #[test]
    fn a_failed_unpair_keeps_the_rows_and_the_idle_schedule() {
        let now = Instant::now();
        let (mut sheet, out) = sheet(false, Some(now));
        sheet.busy = Some("dev_a".to_owned());
        out.send(DeviceEvent::Revoked {
            id: "dev_a".to_owned(),
            result: Err("revoke failed".to_owned()),
        })
        .unwrap();
        assert!(sheet.poll(now));
        assert_eq!(sheet.busy, None);
        assert_eq!(sheet.action_error.as_deref(), Some("revoke failed"));
        assert!(!sheet.in_flight);
    }

    #[test]
    fn one_request_is_in_flight_at_a_time() {
        let now = Instant::now();
        let (mut sheet, _out) = sheet(false, None);
        assert!(!sheet.poll(now), "a request shows no new data yet");
        assert!(sheet.in_flight);
        let started = sheet.last_request;
        sheet.poll(now + REFRESH);
        assert_eq!(
            sheet.last_request, started,
            "the first request is still open"
        );
    }

    #[test]
    fn the_fixture_shows_every_presence_state_and_never_polls() {
        let mut sheet = DevicesSheet::fixture();
        let before = sheet.list.clone();
        assert!(!sheet.poll(Instant::now()));
        assert_eq!(sheet.list, before, "polling must not replace the fixture");
        assert!(!sheet.in_flight, "the fixture must not start a CLI request");

        let DevicesList::Ready(rows) = &sheet.list else {
            panic!("the fixture starts ready");
        };
        assert_eq!(rows.iter().filter(|row| row.is_connected()).count(), 1);
        assert!(rows.iter().any(|row| row.connected == Some(false)));
        assert!(rows.iter().any(|row| row.connected.is_none()));
    }
}
