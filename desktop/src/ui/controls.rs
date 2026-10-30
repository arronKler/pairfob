//! The window's controls: one button shape with three weights, the small
//! status chip, and the caps label that opens each sidebar section.

use gpui::prelude::*;
use gpui::{div, px, AnyElement, Div, MouseButton, MouseDownEvent, SharedString, Window};

use super::theme::{tone, Chrome};
use crate::terminal::Rgb;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ButtonKind {
    /// One per screen: the next step the window is suggesting.
    Primary,
    /// Accent-tinted, for a secondary action that still matters.
    Tinted,
    /// Outlined, for toolbar actions that sit next to plain text.
    Bordered,
    /// Filled in the danger tone, for an action that removes something.
    Danger,
    /// Plain text on hover fill, for dismissal and the tools.
    Quiet,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ButtonSize {
    Regular,
    Small,
}

pub fn button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    chrome: &Chrome,
    kind: ButtonKind,
    on: impl Fn(&MouseDownEvent, &mut Window, &mut gpui::App) + 'static,
) -> gpui::Stateful<Div> {
    sized_button(id, label, chrome, kind, ButtonSize::Regular, on)
}

pub fn small_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    chrome: &Chrome,
    kind: ButtonKind,
    on: impl Fn(&MouseDownEvent, &mut Window, &mut gpui::App) + 'static,
) -> gpui::Stateful<Div> {
    sized_button(id, label, chrome, kind, ButtonSize::Small, on)
}

fn sized_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    chrome: &Chrome,
    kind: ButtonKind,
    size: ButtonSize,
    on: impl Fn(&MouseDownEvent, &mut Window, &mut gpui::App) + 'static,
) -> gpui::Stateful<Div> {
    let label: SharedString = label.into();
    let (background, foreground, hover) = match kind {
        ButtonKind::Primary => (
            Some(chrome.accent),
            chrome.on_accent,
            lighten(chrome.accent, 12),
        ),
        ButtonKind::Tinted => (
            Some(chrome.accent_soft()),
            Chrome::blend(chrome.accent, chrome.foreground, 70),
            Chrome::blend(chrome.hover, chrome.accent_soft(), 40),
        ),
        ButtonKind::Bordered => (None, chrome.foreground, chrome.raised),
        ButtonKind::Danger => (
            Some(chrome.danger),
            chrome.on_accent,
            lighten(chrome.danger, 12),
        ),
        ButtonKind::Quiet => (None, chrome.secondary, chrome.raised),
    };
    let (height, padding, text) = match size {
        ButtonSize::Regular => (30., 14., 12.5),
        ButtonSize::Small => (26., 10., 12.),
    };
    let mut button = div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .h(px(height))
        .px(px(padding))
        .flex_none()
        .rounded(px(6.))
        .text_color(tone(foreground))
        .text_size(px(text))
        .cursor_pointer()
        .hover(move |style| style.bg(tone(hover)))
        .on_mouse_down(MouseButton::Left, on)
        .child(label);
    if let Some(background) = background {
        button = button.bg(tone(background));
    }
    if kind == ButtonKind::Bordered {
        button = button.border(px(1.)).border_color(tone(chrome.line));
    }
    button
}

/// Dot plus label, tinted toward the dot's color. Reads as state, not action.
pub fn chip(label: &str, color: Rgb, chrome: &Chrome) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .h(px(22.))
        .px(px(9.))
        .flex_none()
        .rounded(px(11.))
        .bg(tone(Chrome::blend(color, chrome.background, 14)))
        .child(dot(tone(color), 6.))
        .child(
            div()
                .text_size(px(11.))
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(tone(Chrome::blend(color, chrome.foreground, 55)))
                .child(SharedString::from(label.to_owned())),
        )
        .into_any_element()
}

/// A square color chip used for connection and agent state.
pub fn dot(color: gpui::Rgba, size: f32) -> Div {
    div().size(px(size)).flex_none().rounded_full().bg(color)
}

fn lighten(color: Rgb, percent: u8) -> Rgb {
    let (r, g, b) = color.channels();
    let up = |value: u8| {
        value.saturating_add(((255 - u16::from(value)) * u16::from(percent) / 100) as u8)
    };
    Rgb::new(up(r), up(g), up(b))
}
