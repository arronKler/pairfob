//! The update row in the diagnostics drawer and the toolbar mark that points
//! at it. The checker itself is GPUI-free; this file only renders its state
//! and forwards the two user actions.

use gpui::prelude::*;
use gpui::{div, px, AnyElement, Context, MouseDownEvent, SharedString};

use super::controls::{small_button, ButtonKind};
use super::theme::{tone, Chrome};
use super::window::PairfobWindow;
use crate::update::{Phase, Snapshot};

impl PairfobWindow {
    /// Whether the toolbar should point at an available update. A small dot,
    /// not another control, so the compact toolbar keeps its control count.
    pub(crate) fn update_available(&self) -> bool {
        matches!(self.updater.snapshot().phase, Phase::Available)
    }

    /// Returns whether the checker changed something this window shows. A
    /// restart is the only state the window acts on by itself: the worker has
    /// already started the new process, so this one can close.
    pub(crate) fn poll_update(&mut self, cx: &mut Context<Self>) -> bool {
        let snapshot = self.updater.snapshot();
        if snapshot.revision == self.update_revision {
            return false;
        }
        self.update_revision = snapshot.revision;
        if snapshot.phase == Phase::Restarting {
            cx.quit();
        }
        true
    }

    pub(crate) fn update_row(&self, chrome: &Chrome, cx: &mut Context<Self>) -> AnyElement {
        let snapshot = self.updater.snapshot();
        let (status, color) = status(&snapshot, chrome);
        let busy = matches!(
            snapshot.phase,
            Phase::Checking | Phase::Downloading | Phase::Restarting
        );

        let mut actions = div().flex().items_center().gap(px(4.)).flex_none();
        if matches!(snapshot.phase, Phase::Available) {
            actions = actions.child(small_button(
                "update-install",
                "Update",
                chrome,
                ButtonKind::Primary,
                cx.listener(|this, _: &MouseDownEvent, _window, cx| {
                    this.updater.install_now();
                    cx.notify();
                }),
            ));
        } else if matches!(snapshot.phase, Phase::Failed(_)) && snapshot.latest.is_some() {
            actions = actions.child(small_button(
                "update-retry",
                "Retry update",
                chrome,
                ButtonKind::Primary,
                cx.listener(|this, _: &MouseDownEvent, _window, cx| {
                    this.updater.install_now();
                    cx.notify();
                }),
            ));
        }
        if !busy && !matches!(snapshot.phase, Phase::Disabled) {
            actions = actions.child(small_button(
                "update-check",
                "Check",
                chrome,
                ButtonKind::Quiet,
                cx.listener(|this, _: &MouseDownEvent, _window, cx| {
                    this.updater.check_now();
                    cx.notify();
                }),
            ));
        }

        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .px(px(14.))
            .py(px(10.))
            .flex_none()
            .border_b(px(1.))
            .border_color(tone(chrome.line_soft))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(12.))
                            .text_color(tone(chrome.secondary))
                            .child("Updates"),
                    )
                    .child(
                        div()
                            .text_size(px(10.5))
                            .text_color(tone(chrome.muted))
                            .child(SharedString::from(format!(
                                "Pairfob Desktop {}",
                                snapshot.current
                            ))),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(11.5))
                            .line_height(px(17.))
                            .text_color(tone(color))
                            .whitespace_normal()
                            .child(SharedString::from(status)),
                    )
                    .child(actions),
            )
            .into_any_element()
    }
}

fn status(snapshot: &Snapshot, chrome: &Chrome) -> (String, crate::terminal::Rgb) {
    match &snapshot.phase {
        Phase::Idle => ("Ready to check".to_owned(), chrome.muted),
        Phase::Checking => ("Checking for updates…".to_owned(), chrome.secondary),
        Phase::UpToDate => ("Up to date".to_owned(), chrome.success),
        Phase::Available => (
            format!(
                "Update available: {} → {}",
                snapshot.current,
                snapshot.latest.as_deref().unwrap_or("a newer build")
            ),
            chrome.accent,
        ),
        Phase::Unsupported => (
            "No build is published for this platform".to_owned(),
            chrome.muted,
        ),
        Phase::Downloading => (
            format!(
                "Downloading {}…",
                snapshot.latest.as_deref().unwrap_or("the update")
            ),
            chrome.warning,
        ),
        Phase::Restarting => ("Restarting…".to_owned(), chrome.success),
        Phase::Failed(error) => (error.clone(), chrome.danger),
        Phase::Disabled => ("Update checks are off".to_owned(), chrome.muted),
    }
}
