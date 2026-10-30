//! What runs in a pane, drawn at the start of its session row: the agent's
//! mark when the kind has one, a monogram otherwise, and the status as a
//! corner dot. A pane without an agent keeps the plain status dot.

use gpui::prelude::*;
use gpui::{div, px, svg, AnyElement, FontWeight, SharedString};

use crate::terminal::Rgb;

use super::agent_marks_data::{Mark, MARKS};
use super::controls::dot;
use super::theme::{tone, Chrome};

/// The square's side. It is also the width of the row's leading slot, so a
/// pane without an agent keeps its label aligned with the others.
pub(crate) const SIZE: f32 = 15.;
const BADGE: f32 = 5.;

/// Advertised kind strings that name the same agent as a listed mark.
const ALIASES: &[(&str, &str)] = &[
    ("agy", "antigravity"),
    ("amp-code", "amp"),
    ("claude-code", "claude"),
    ("claudecode", "claude"),
    ("cline-cli", "cline"),
    ("copilot-cli", "copilot"),
    ("cursor-agent", "cursor"),
    ("cursor-cli", "cursor"),
    ("gemini-cli", "gemini"),
    ("github-copilot", "copilot"),
    ("google-antigravity", "antigravity"),
    ("grok-cli", "grok"),
    ("kilo", "kilocode"),
    ("kilo-code", "kilocode"),
    ("letta-cli", "letta"),
    ("letta-code", "letta"),
    ("openai-codex", "codex"),
    ("pi-agent", "pi"),
    ("pi-coding-agent", "pi"),
    ("qwen-code", "qwen"),
    ("qwencode", "qwen"),
    ("roo", "roocode"),
    ("roo-code", "roocode"),
];

/// The mark for an advertised kind, or `None` when a monogram should stand in.
pub(crate) fn mark(kind: &str) -> Option<&'static Mark> {
    let key = kind.trim().to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    let key = ALIASES
        .iter()
        .find(|(alias, _)| *alias == key)
        .map_or(key.as_str(), |(_, target)| *target);
    MARKS.iter().find(|mark| mark.kind == key)
}

/// The two letters a kind without a mark shows.
pub(crate) fn monogram(kind: &str) -> String {
    let mut letters = kind.chars().filter(|letter| letter.is_ascii_alphanumeric());
    let Some(first) = letters.next() else {
        return "?".to_owned();
    };
    let mut text = first.to_ascii_uppercase().to_string();
    if let Some(second) = letters.next() {
        text.push(second.to_ascii_lowercase());
    }
    text
}

/// The row's leading square. `status` colors the corner dot; `None` hides it.
pub(crate) fn avatar(
    kind: &str,
    selected: bool,
    status: Option<Rgb>,
    chrome: &Chrome,
) -> AnyElement {
    let text = tone(if selected {
        chrome.on_accent
    } else {
        chrome.secondary
    });
    let content: AnyElement = match mark(kind) {
        Some(mark) => svg()
            .data(mark.svg.as_bytes())
            .size(px(SIZE))
            .text_color(text)
            .into_any_element(),
        None => {
            let background = if selected {
                tone(Chrome::blend(chrome.on_accent, chrome.selected, 20))
            } else {
                tone(chrome.raised)
            };
            monogram_tile(&monogram(kind), background, text)
        }
    };

    let mut square = div().relative().flex_none().size(px(SIZE)).child(content);
    if let Some(color) = status {
        square = square.child(
            dot(tone(color), BADGE)
                .absolute()
                .right(px(-1.))
                .bottom(px(-1.))
                .border(px(1.))
                .border_color(tone(if selected {
                    chrome.selected
                } else {
                    chrome.sidebar
                })),
        );
    }
    square.into_any_element()
}

fn monogram_tile(text: &str, background: gpui::Rgba, color: gpui::Rgba) -> AnyElement {
    div()
        .size(px(SIZE))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .bg(background)
        .text_size(px(8.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(color)
        .child(SharedString::from(text.to_owned()))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_and_case_reach_the_same_mark() {
        assert_eq!(mark("Claude-Code").map(|mark| mark.kind), Some("claude"));
        assert_eq!(mark(" opencode ").map(|mark| mark.kind), Some("opencode"));
        assert_eq!(mark("cursor-agent").map(|mark| mark.kind), Some("cursor"));
        assert!(mark("aider").is_none());
        assert!(mark("").is_none());
    }

    #[test]
    fn every_alias_names_a_listed_mark() {
        for (alias, target) in ALIASES {
            assert!(
                MARKS.iter().any(|mark| mark.kind == *target),
                "{alias} names {target}, which has no mark"
            );
        }
    }

    #[test]
    fn marks_are_complete_svg_documents_with_unique_kinds() {
        for mark in MARKS {
            assert!(mark.svg.starts_with("<svg"), "{}", mark.kind);
            assert!(mark.svg.ends_with("</svg>"), "{}", mark.kind);
        }
        let mut kinds: Vec<&str> = MARKS.iter().map(|mark| mark.kind).collect();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), MARKS.len());
    }

    #[test]
    fn a_kind_without_a_mark_gets_two_letters() {
        assert_eq!(monogram("prime agent"), "Pr");
        assert_eq!(monogram("hermes"), "He");
        assert_eq!(monogram("x"), "X");
        assert_eq!(monogram("---"), "?");
    }
}
