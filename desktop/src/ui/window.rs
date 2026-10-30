//! The one window's state: the engine's latest events, the lifecycle screens,
//! the pairing sheet, and the geometry file. Rendering and the input handlers
//! live in sibling modules.

use std::cell::{Cell, RefCell};
use std::collections::{HashSet, VecDeque};
use std::ops::Range;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::Receiver;
#[cfg(feature = "shot")]
use gpui::{point, px, Point};
use gpui::{Bounds, Context, FocusHandle, Pixels, ScrollHandle, Window};

use crate::app::{App, AppEvent, Connection, Notice};
use crate::chat::ChatEvent;
use crate::herdr::{Desktop, EngineHandle};
use crate::model::{PaneId, Size, SplitRect, TabId};
use crate::terminal::Theme;

use super::boot::Boot;
use super::chat::ChatSession;
use super::devices::DevicesSheet;
use super::find::FindState;
use super::geometry::{Saved, SAVE_INTERVAL};
use super::glyphs::GlyphCache;
use super::menu::{ContextMenu, MenuAction};
use super::pairing::PairingSheet;
use super::rename::RenameState;
use super::selection::Selection;
use super::sessions::SessionsSheet;
use super::slide::{self, Slide};
use super::terminal::{spawn_resize_worker, CellMetrics};
use super::theme::{Appearance, Chrome};

/// Events wake the window as they arrive; the tick only drives clocks (the
/// pairing countdown) and the startup tasks' results. A keystroke therefore
/// does not wait for a poll interval before it reaches the screen. The queue
/// is bounded so a stalled window cannot grow memory without limit; dropping
/// old frames is safe because newer frames replace them.
const MAILBOX_LIMIT: usize = 2048;
const TICK_INTERVAL: Duration = Duration::from_millis(250);

/// A divider being dragged. The endpoint is told once, on release, so the
/// layout command lane never queues a request per mouse sample.
#[derive(Clone, Debug)]
pub(crate) struct SplitDrag {
    pub(crate) tab: TabId,
    pub(crate) split: SplitRect,
    pub(crate) ratio: f32,
}

pub(crate) struct PairfobWindow {
    pub(crate) app: App,
    pub(crate) handle: EngineHandle,
    pub(crate) focus: FocusHandle,
    pub(crate) chrome: Chrome,
    pub(crate) terminal_theme: Theme,
    /// What the user asked for; `Auto` follows the system appearance.
    pub(crate) appearance: Appearance,
    /// The sidebar's requested width before clamping, and whether it is hidden.
    pub(crate) sidebar_width: f32,
    pub(crate) sidebar_collapsed: bool,
    /// Pointer start and width while the sidebar edge is dragged.
    pub(crate) sidebar_drag: Option<(f32, f32)>,
    /// The session filter query and whether typing goes to it.
    pub(crate) filter: String,
    pub(crate) filter_active: bool,
    pub(crate) split_drag: Option<SplitDrag>,
    /// The attached chat process, and the panes whose user opened its column.
    pub(crate) chat: Option<ChatSession>,
    pub(crate) chat_panes: HashSet<PaneId>,
    pub(crate) chat_error: Option<String>,
    pub(crate) chat_attempted: Option<(PaneId, String)>,
    /// The chat composer's text, including text the input method committed.
    pub(crate) composer: String,
    pub(crate) chat_mailbox: Arc<Mutex<VecDeque<ChatEvent>>>,
    pub(crate) wake: async_channel::Sender<()>,
    pub(crate) cell: CellMetrics,
    /// Text size the user picked, in points; the cell is measured from it.
    pub(crate) font_size: f32,
    /// The Herdr session this window is attached to; `None` is the default.
    pub(crate) session: Option<String>,
    pub(crate) glyph_cache: Rc<RefCell<GlyphCache>>,
    pub(crate) ops_cache: Rc<RefCell<crate::terminal::paint::OpsCache>>,
    pub(crate) canvas_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    pub(crate) resize_tx: crossbeam_channel::Sender<Size>,
    pub(crate) boot: Boot,
    /// The desktop release checker; it starts before the first render so an
    /// update found at launch is already known when Diagnostics opens.
    pub(crate) updater: crate::update::Updater,
    /// The last checker revision this window drew.
    pub(crate) update_revision: u64,
    pub(crate) pairing: Option<PairingSheet>,
    pub(crate) devices: Option<DevicesSheet>,
    pub(crate) devices_scroll: ScrollHandle,
    pub(crate) sessions: Option<SessionsSheet>,
    /// How many Herdr sessions this computer has, so the toolbar only offers
    /// the switcher when there is somewhere to switch to.
    pub(crate) session_count: usize,
    pub(crate) find: Option<FindState>,
    pub(crate) rename: Option<RenameState>,
    pub(crate) marked: String,
    pub(crate) marked_selection: Option<Range<usize>>,
    /// What is selected and copied from the terminal.
    pub(crate) selection: Option<Selection>,
    /// The drag in flight; the selection is only written once it moves.
    pub(crate) drag: Option<Selection>,
    pub(crate) menu: Option<ContextMenu>,
    pub(crate) menu_hover: Option<MenuAction>,
    /// Sub-cell wheel motion carried to the next scroll event.
    pub(crate) wheel_remainder: f32,
    /// The wheel gesture drawn ahead of the daemon's next frame.
    pub(crate) wheel_slide: Option<Slide>,
    pub(crate) sidebar_scroll: ScrollHandle,
    pub(crate) diagnostics_scroll: ScrollHandle,
    /// Whether the development performance HUD is on screen; F12 toggles it.
    #[cfg(feature = "perf-hud")]
    pub(crate) show_perf_hud: bool,
    /// The menu shot opens only once a frame supplies a selection to show, so
    /// Copy never appears disabled for want of timing.
    #[cfg(feature = "shot")]
    shot_menu_pending: Option<Point<Pixels>>,
    /// The chat shot waits for the first pane with a chat token, then opens it.
    #[cfg(feature = "shot")]
    shot_chat_pending: bool,
    /// The find shot holds an invented query, so the tick must not retire it
    /// for having no pane to search.
    #[cfg(feature = "shot")]
    pub(crate) shot_find_pending: bool,
    last_bounds: Option<Bounds<Pixels>>,
    last_save: Option<Instant>,
    pub(crate) mailbox: Arc<Mutex<VecDeque<AppEvent>>>,
}

impl PairfobWindow {
    pub fn new(
        desktop: Desktop,
        session: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let Desktop { handle, events } = desktop;
        let mailbox = Arc::new(Mutex::new(VecDeque::new()));
        let (wake_tx, wake_rx) = async_channel::bounded::<()>(1);
        spawn_pump(events, Arc::clone(&mailbox), wake_tx.clone());
        let resize_tx = spawn_resize_worker(handle.clone());
        let saved = Saved::load();
        let appearance = std::env::var("PF_DESKTOP_APPEARANCE")
            .ok()
            .and_then(|value| Appearance::parse(&value))
            .unwrap_or(saved.appearance);
        let chrome = Chrome::for_dark(appearance.is_dark(window.appearance()));
        let terminal_theme = chrome.terminal();
        let font_size = super::layout::clamp_font_size(saved.font_size);
        let cell = CellMetrics::measure_at(window, font_size);
        let updater = crate::update::Updater::start();
        let update_revision = updater.snapshot().revision;
        let mut this = Self {
            app: App::default(),
            handle,
            focus: cx.focus_handle(),
            terminal_theme,
            chrome,
            appearance,
            sidebar_width: super::layout::sidebar_width(
                saved.sidebar_width,
                saved.sidebar_collapsed,
            ),
            sidebar_collapsed: saved.sidebar_collapsed,
            sidebar_drag: None,
            filter: String::new(),
            filter_active: false,
            split_drag: None,
            chat: None,
            chat_panes: HashSet::new(),
            chat_error: None,
            chat_attempted: None,
            composer: String::new(),
            chat_mailbox: Arc::new(Mutex::new(VecDeque::new())),
            wake: wake_tx,
            cell,
            font_size,
            session: session.clone(),
            glyph_cache: Rc::new(RefCell::new(GlyphCache::default())),
            ops_cache: Rc::new(RefCell::new(crate::terminal::paint::OpsCache::default())),
            canvas_bounds: Rc::new(Cell::new(None)),
            resize_tx,
            boot: Boot::start(session),
            updater,
            update_revision,
            pairing: None,
            devices: None,
            devices_scroll: ScrollHandle::new(),
            sessions: None,
            session_count: crate::process::sessions::list().len(),
            find: None,
            rename: None,
            marked: String::new(),
            marked_selection: None,
            selection: None,
            drag: None,
            menu: None,
            menu_hover: None,
            wheel_remainder: 0.,
            wheel_slide: None,
            sidebar_scroll: ScrollHandle::new(),
            diagnostics_scroll: ScrollHandle::new(),
            #[cfg(feature = "perf-hud")]
            show_perf_hud: true,
            #[cfg(feature = "shot")]
            shot_menu_pending: None,
            #[cfg(feature = "shot")]
            shot_chat_pending: false,
            #[cfg(feature = "shot")]
            shot_find_pending: false,
            last_bounds: None,
            last_save: None,
            mailbox,
        };
        this.note_bounds(window);
        window.focus(&this.focus, cx);

        // Screenshots of the overlays. `PF_DESKTOP_SHOT_OPEN` names the one to
        // show; the pairing sheet uses an invented code, never a live offer.
        #[cfg(feature = "shot")]
        if let Ok(state) = std::env::var("PF_DESKTOP_SHOT_UPDATE") {
            this.updater.fixture(&state);
            this.update_revision = this.updater.snapshot().revision;
        }
        #[cfg(feature = "shot")]
        if let Ok(open) = std::env::var("PF_DESKTOP_SHOT_OPEN") {
            match open.as_str() {
                "pairing" => this.pairing = Some(PairingSheet::fixture()),
                "diagnostics" => this.boot.open_diagnostics(),
                "devices" => this.devices = Some(DevicesSheet::fixture()),
                "devices-confirm" => {
                    let mut sheet = DevicesSheet::fixture();
                    sheet.confirm = Some("dev_fixture_phone".to_owned());
                    this.devices = Some(sheet);
                }
                "menu" => {
                    this.shot_menu_pending = Some(point(px(300.), px(220.)));
                }
                "chat" => this.shot_chat_pending = true,
                "find" => {
                    this.find = Some(FindState::fixture(crate::model::PaneId::from("shot:p1")));
                    this.shot_find_pending = true;
                }
                "rename" => {
                    this.rename = Some(RenameState {
                        pane: crate::model::PaneId::from("shot:p1"),
                        text: "api-server".to_owned(),
                        error: None,
                    });
                }
                "sessions" => {
                    this.sessions = Some(SessionsSheet::fixture(this.session.clone()));
                    this.session_count = 3;
                }
                other => eprintln!("shot: unknown overlay {other}"),
            }
        }

        cx.observe_window_bounds(window, |this, window, _| {
            this.note_bounds(window);
        })
        .detach();
        // macOS flips appearance while the window is open; an explicit choice
        // in the app wins, `Auto` follows along.
        cx.observe_window_appearance(window, |this, window, cx| {
            if this.appearance != Appearance::Auto {
                return;
            }
            this.apply_appearance(window.appearance(), cx);
        })
        .detach();
        cx.on_release(|this, _| {
            this.handle.shutdown();
            this.save_geometry();
        })
        .detach();

        // The engine's receiver is blocking and crossbeam, while GPUI's
        // foreground wants futures. The pump thread wakes this task only when
        // it has something queued, so a keystroke reaches the screen on the
        // next frame instead of on the next poll.
        cx.spawn(async move |this, cx| {
            while wake_rx.recv().await.is_ok() {
                if this.update(cx, |this, cx| this.pump(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();

        // The tick is only for clocks and for work that finishes without an
        // engine event: the pairing countdown and the startup tasks' results.
        let executor = cx.background_executor().clone();
        cx.spawn(async move |this, cx| loop {
            executor.timer(TICK_INTERVAL).await;
            if this.update(cx, |this, cx| this.pump(cx)).is_err() {
                break;
            }
        })
        .detach();

        this
    }

    fn pump(&mut self, cx: &mut Context<Self>) {
        let mut changed = false;
        let events: Vec<AppEvent> = match self.mailbox.lock() {
            Ok(mut queue) => queue.drain(..).collect(),
            Err(_) => Vec::new(),
        };
        for event in events {
            if let AppEvent::Search {
                request_id,
                outcome,
            } = event
            {
                changed |= self.apply_find_result(request_id, outcome, cx);
                continue;
            }
            let ready = matches!(event, AppEvent::Connection(Connection::Ready));
            if let AppEvent::Connection(next) = &event {
                if next != &self.app.connection {
                    crate::log::info(&format!("herdr connection: {}", next.label()));
                }
            }
            self.app.apply(event);
            if ready {
                self.boot.connected();
            }
            changed = true;
        }
        let chat_events: Vec<ChatEvent> = match self.chat_mailbox.lock() {
            Ok(mut queue) => queue.drain(..).collect(),
            Err(_) => Vec::new(),
        };
        for event in chat_events {
            self.apply_chat_event(event);
            changed = true;
        }
        self.sync_chat(cx);
        if self.boot.poll() {
            changed = true;
        }
        if self.poll_update(cx) {
            changed = true;
        }
        changed |= self.poll_find(Instant::now(), cx);
        changed |= self.reconcile_slide(Instant::now());

        // The menu shot needs a live frame to select from; the first one that
        // arrives supplies the selection, and only then does the menu open over
        // it. It never touches the clipboard.
        #[cfg(feature = "shot")]
        if let Some(at) = self.shot_menu_pending {
            if let Some(selection) = shot_selection(&self.app) {
                self.selection = Some(selection);
                self.menu = Some(ContextMenu { at });
                self.shot_menu_pending = None;
                changed = true;
            }
        }

        #[cfg(feature = "shot")]
        if self.shot_chat_pending {
            let pane = self.app.session.as_ref().and_then(|session| {
                session
                    .workspaces
                    .iter()
                    .flat_map(|workspace| workspace.tabs.iter())
                    .flat_map(|tab| tab.panes.iter())
                    .find(|pane| pane.chat_id().is_some())
                    .map(|pane| pane.id.clone())
            });
            if let Some(pane) = pane {
                self.chat_panes.insert(pane);
                self.shot_chat_pending = false;
                changed = true;
            }
        }

        let mut close_pairing = false;
        if let Some(sheet) = self.pairing.as_mut() {
            let update = sheet.poll(SystemTime::now());
            changed |= update.changed;
            close_pairing = update.close;
        }
        if close_pairing {
            self.pairing = None;
            changed = true;
        }

        if let Some(sheet) = self.devices.as_mut() {
            changed |= sheet.poll(Instant::now());
        }

        if changed {
            cx.notify();
        }
    }

    /// Drops the wheel prediction once a frame has reached it, or when the
    /// frame went somewhere the gesture did not, or when no frame arrived at
    /// all. Reports whether a drop changed what is on screen.
    fn reconcile_slide(&mut self, now: Instant) -> bool {
        let Some(slide) = self.wheel_slide.as_ref() else {
            return false;
        };
        let done = self
            .app
            .frame
            .as_ref()
            .is_none_or(|frame| slide::finished(slide, frame))
            || slide::stale(slide, now);
        if done {
            self.wheel_slide = None;
        }
        done
    }

    /// The last window width GPUI reported, or a desktop-sized default before
    /// the first bounds callback arrives.
    pub(crate) fn window_width(&self) -> f32 {
        self.last_bounds
            .map(|bounds| bounds.size.width.as_f32())
            .unwrap_or(1440.)
    }

    /// The width the toolbar, the chat and the footer actually get: the window
    /// minus the sidebar's share.
    pub(crate) fn content_width(&self) -> f32 {
        self.window_width()
            - super::layout::sidebar_width(self.sidebar_width, self.sidebar_collapsed)
    }

    fn note_bounds(&mut self, window: &Window) {
        let bounds = window.window_bounds().get_bounds();
        self.last_bounds = Some(bounds);
        if self
            .last_save
            .is_none_or(|saved| saved.elapsed() >= SAVE_INTERVAL)
        {
            self.save_geometry();
        }
    }

    pub(super) fn save_geometry(&mut self) {
        let Some(bounds) = self.last_bounds else {
            return;
        };
        Saved {
            sidebar_width: self.sidebar_width,
            sidebar_collapsed: self.sidebar_collapsed,
            appearance: self.appearance,
            font_size: self.font_size,
            ..Saved::from_bounds(bounds)
        }
        .save();
        self.last_save = Some(Instant::now());
    }

    pub(crate) fn focus_canvas(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    /// Repaint the chrome and the terminal for the scheme `system` resolves to
    /// under the current choice. A no-op when the scheme does not change, so a
    /// redundant appearance notification never rebuilds the glyph cache.
    pub(crate) fn apply_appearance(
        &mut self,
        system: gpui::WindowAppearance,
        cx: &mut Context<Self>,
    ) {
        let dark = self.appearance.is_dark(system);
        if dark == self.chrome.dark {
            return;
        }
        self.chrome = Chrome::for_dark(dark);
        self.terminal_theme = self.chrome.terminal();
        cx.notify();
    }

    /// Pin the scheme the user picked. The choice is saved right away rather
    /// than at quit, so a crash does not lose it.
    pub(crate) fn set_appearance(
        &mut self,
        appearance: Appearance,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.appearance == appearance {
            return;
        }
        self.appearance = appearance;
        self.apply_appearance(window.appearance(), cx);
        self.save_geometry();
        cx.notify();
    }

    /// ⌘⇧A: flip to the explicit scheme opposite of what is on screen. While
    /// following the system this is the only press that visibly changes
    /// anything, so it never lands on the scheme already showing.
    pub(crate) fn toggle_appearance(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let next = self.appearance.toggled(window.appearance());
        self.set_appearance(next, window, cx);
    }

    pub(crate) fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar_collapsed = !self.sidebar_collapsed;
        cx.notify();
    }

    pub(crate) fn start_filter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.filter_active = true;
        self.focus_canvas(window, cx);
        cx.notify();
    }

    pub(crate) fn edit_filter(&mut self, text: &str, cx: &mut Context<Self>) {
        if !self.filter_active {
            return;
        }
        self.filter.push_str(text);
        cx.notify();
    }

    pub(crate) fn filter_backspace(&mut self, cx: &mut Context<Self>) {
        self.filter.pop();
        cx.notify();
    }

    /// Escape leaves the filter with the query kept; a second escape clears
    /// it. The filter never steals keys from the pane once it is closed.
    pub(crate) fn leave_filter(&mut self, clear: bool, cx: &mut Context<Self>) {
        self.filter_active = false;
        self.marked.clear();
        self.marked_selection = None;
        if clear {
            self.filter.clear();
        }
        cx.notify();
    }

    pub(crate) fn copy_diagnostics(&mut self, cx: &mut Context<Self>) {
        let text = self.boot.diagnostics_text();
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
        self.boot.mark_copied();
        cx.notify();
    }

    pub(crate) fn focus_pane(&mut self, pane: PaneId, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_canvas(window, cx);
        let _ = self.handle.focus(pane);
        self.sync_chat(cx);
    }

    pub(crate) fn notify(&mut self, notice: Notice, cx: &mut Context<Self>) {
        self.app.notice = Some(notice);
        cx.notify();
    }

    pub(crate) fn open_pairing(&mut self, cx: &mut Context<Self>) {
        if self.pairing.is_some() {
            return;
        }
        if self.boot.tools().is_none() {
            // The user may have installed pairfob since the window opened.
            self.boot.retry();
        }
        let Some(tools) = self.boot.tools().cloned() else {
            self.notify(
                Notice::warning("Pairfob is not installed yet; run the install command first."),
                cx,
            );
            return;
        };
        self.pairing = Some(PairingSheet::start(tools.pairfob));
        cx.notify();
    }

    pub(crate) fn close_pairing(&mut self, cx: &mut Context<Self>) {
        if let Some(sheet) = self.pairing.take() {
            sheet.cancel();
        }
        cx.notify();
    }

    pub(crate) fn restart_pairing(&mut self, cx: &mut Context<Self>) {
        if let Some(sheet) = self.pairing.take() {
            sheet.cancel();
        }
        self.open_pairing(cx);
    }

    /// The Devices drawer and the diagnostics drawer share the same corner, so
    /// opening one closes the other.
    pub(crate) fn open_devices(&mut self, cx: &mut Context<Self>) {
        if self.boot.tools().is_none() {
            // The user may have installed pairfob since the window opened.
            self.boot.retry();
        }
        let Some(tools) = self.boot.tools().cloned() else {
            self.notify(
                Notice::warning("Pairfob is not installed yet; run the install command first."),
                cx,
            );
            return;
        };
        self.boot.close_diagnostics();
        if self.devices.is_none() {
            self.devices = Some(DevicesSheet::start(tools.pairfob));
        }
        cx.notify();
    }

    pub(crate) fn close_devices(&mut self, cx: &mut Context<Self>) {
        if self.devices.take().is_some() {
            cx.notify();
        }
    }

    pub(crate) fn open_diagnostics(&mut self, cx: &mut Context<Self>) {
        self.devices = None;
        self.boot.open_diagnostics();
        cx.notify();
    }

    pub(crate) fn close_diagnostics(&mut self, cx: &mut Context<Self>) {
        self.boot.close_diagnostics();
        cx.notify();
    }

    pub(crate) fn rerun_doctor(&mut self, cx: &mut Context<Self>) {
        self.boot.rerun_doctor();
        cx.notify();
    }

    pub(crate) fn run_setup(&mut self, cx: &mut Context<Self>) {
        self.boot.run_setup();
        cx.notify();
    }

    pub(crate) fn retry(&mut self, cx: &mut Context<Self>) {
        self.boot.retry();
        cx.notify();
    }
}

impl Drop for PairfobWindow {
    fn drop(&mut self) {
        self.handle.shutdown();
    }
}

/// Two rows over the focused pane's first cells, so a menu shot renders Copy
/// as enabled without a real drag.
#[cfg(feature = "shot")]
fn shot_selection(app: &App) -> Option<Selection> {
    let frame = app.frame.as_ref()?;
    let pane = app.focused_pane()?;
    let rect = frame
        .panes
        .iter()
        .find(|candidate| candidate.id == pane)?
        .rect;
    if rect.width == 0 || rect.height == 0 {
        return None;
    }
    Some(Selection {
        pane,
        anchor: (rect.x, rect.y),
        head: (rect.right() - 1, (rect.y + 1).min(rect.bottom() - 1)),
    })
}

pub(super) fn spawn_pump(
    events: Receiver<AppEvent>,
    mailbox: Arc<Mutex<VecDeque<AppEvent>>>,
    wake: async_channel::Sender<()>,
) {
    thread::spawn(move || {
        while let Ok(event) = events.recv() {
            match mailbox.lock() {
                Ok(mut queue) => {
                    queue.push_back(event);
                    if queue.len() > MAILBOX_LIMIT {
                        queue.pop_front();
                    }
                }
                Err(_) => break,
            }
            // A full wake channel already has an unmatched signal, which is
            // all this task needs to drain whatever arrived in the meantime.
            let _ = wake.try_send(());
        }
    });
}
