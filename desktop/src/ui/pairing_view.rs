//! The pairing overlay: one sheet over the session, the six-character code,
//! the QR matrix as quads, and the countdown. It floats, so the terminal box
//! underneath does not resize while it is open.

use gpui::prelude::*;
use gpui::{
    canvas, div, fill, point, px, size, AnyElement, Bounds, Context, FontWeight, MouseButton,
    MouseDownEvent, Window,
};

use crate::pairing::QrMatrix;
use crate::terminal::Rgb;

use super::controls::{button, small_button, ButtonKind};
use super::layout;
use super::pairing::PairingState;
use super::theme::{mono_font_bold, tone};
use super::window::PairfobWindow;

const SHEET_WIDTH: f32 = 396.;
const QR_SIDE: f32 = 208.;
const QR_PLATE: f32 = 12.;

impl PairfobWindow {
    pub(crate) fn pairing_sheet(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let chrome = self.chrome.clone();
        let sheet = self.pairing.as_ref()?;
        let state = sheet.state.clone();
        let code = sheet
            .offer
            .as_ref()
            .map(|offer| offer.code.clone())
            .unwrap_or_default();
        let matrix = sheet.matrix.clone();
        let countdown = sheet.countdown();

        let side = layout::qr_side(f32::from(window.viewport_size().height), QR_SIDE);

        let mut body = div().flex().flex_col().items_center().gap(px(14.)).w_full();

        match &state {
            PairingState::Starting => {
                body = body.child(line("Starting pairfob pair offer…", chrome.muted, 12.));
            }
            PairingState::Offer | PairingState::Ready => {
                body = body.child(
                    div()
                        .font(mono_font_bold())
                        .text_size(px(30.))
                        .text_color(tone(chrome.foreground))
                        .child(spaced(&code)),
                );
                match &matrix {
                    Some(matrix) => {
                        body = body.child(qr_plate(matrix.clone(), side, &chrome));
                    }
                    None => {
                        body = body.child(line(
                            "The QR code could not be drawn; enter the code instead.",
                            chrome.warning,
                            11.,
                        ));
                    }
                }
                if !countdown.is_empty() {
                    body = body.child(
                        div()
                            .h(px(22.))
                            .px(px(9.))
                            .rounded(px(11.))
                            .bg(tone(chrome.background))
                            .flex()
                            .items_center()
                            .text_size(px(11.))
                            .text_color(tone(chrome.secondary))
                            .child(format!("Expires in {countdown}")),
                    );
                }
                let status = if state == PairingState::Ready {
                    "Phone found. Finishing the handshake…"
                } else {
                    "Scan with Pairfob on your phone, or type the code there."
                };
                body = body.child(line(status, chrome.muted, 12.));
            }
            PairingState::Paired => {
                body = body.child(line("Paired", chrome.success, 22.));
                body = body.child(line(
                    "This computer can connect to your phone now.",
                    chrome.muted,
                    12.,
                ));
            }
            PairingState::Failed(message) => {
                body = body.child(line("Pairing did not finish", chrome.danger, 16.));
                body = body.child(line(message, chrome.muted, 12.));
            }
        }

        let footer = match &state {
            PairingState::Paired => None,
            PairingState::Failed(_) => Some(
                div()
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap(px(8.))
                    .w_full()
                    .child(small_button(
                        "pairing-close",
                        "Close",
                        &chrome,
                        ButtonKind::Quiet,
                        cx.listener(|this, _: &MouseDownEvent, _window, cx| this.close_pairing(cx)),
                    ))
                    .child(button(
                        "pairing-retry",
                        "Try again",
                        &chrome,
                        ButtonKind::Primary,
                        cx.listener(|this, _: &MouseDownEvent, _window, cx| {
                            this.restart_pairing(cx)
                        }),
                    )),
            ),
            _ => Some(
                div()
                    .flex()
                    .items_center()
                    .justify_end()
                    .w_full()
                    .child(small_button(
                        "pairing-cancel",
                        "Cancel",
                        &chrome,
                        ButtonKind::Quiet,
                        cx.listener(|this, _: &MouseDownEvent, _window, cx| this.close_pairing(cx)),
                    )),
            ),
        };

        let card = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .w(px(SHEET_WIDTH))
            .p(px(22.))
            .rounded(px(layout::RADIUS_CARD))
            .bg(tone(chrome.card))
            .border(px(1.))
            .border_color(tone(chrome.line))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .w_full()
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(tone(chrome.foreground))
                            .child("Pair a device"),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(tone(chrome.muted))
                            .child("The phone gets the panes; the keys stay here."),
                    ),
            )
            .child(body)
            .children(footer);

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .p(px(16.))
                .bg(gpui::rgba(0x00000099))
                // Keep clicks on the backdrop away from the terminal below.
                .on_mouse_down(MouseButton::Left, |_, _, _| {})
                .child(card.into_any_element())
                .into_any_element(),
        )
    }
}

fn line(text: &str, color: Rgb, size_px: f32) -> AnyElement {
    div()
        .text_size(px(size_px))
        .text_color(tone(color))
        .whitespace_normal()
        .child(text.to_owned())
        .into_any_element()
}

/// GPUI has no letter spacing, so the code is spaced with thin spaces. The
/// digits stay contiguous for a screen reader, and the card reads as a code.
fn spaced(code: &str) -> String {
    code.chars()
        .map(|ch| ch.to_string())
        .collect::<Vec<_>>()
        .join("\u{2009}")
}

fn qr_plate(matrix: QrMatrix, side: f32, chrome: &super::theme::Chrome) -> AnyElement {
    let white = tone(Rgb::new(0xff, 0xff, 0xff));
    let ink = tone(Rgb::new(0x0b, 0x0d, 0x10));
    let modules = matrix.width.max(1) as f32;
    div()
        .p(px(QR_PLATE))
        .flex_none()
        .rounded(px(layout::RADIUS_CARD))
        .bg(white)
        .border(px(1.))
        .border_color(tone(chrome.line))
        .child(
            div().size(px(side)).flex_none().child(
                canvas(
                    move |_, _, _| {},
                    move |bounds, _, window, _| {
                        let module_px = f32::from(bounds.size.width) / modules;
                        for y in 0..matrix.width {
                            for x in 0..matrix.width {
                                if !matrix.get(x, y) {
                                    continue;
                                }
                                let rect = Bounds::new(
                                    bounds.origin
                                        + point(px(x as f32 * module_px), px(y as f32 * module_px)),
                                    size(px(module_px), px(module_px)),
                                );
                                window.paint_quad(fill(rect, ink));
                            }
                        }
                    },
                )
                .size_full(),
            ),
        )
        .into_any_element()
}
