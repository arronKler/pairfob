//! Cells in, draw instructions out. This module is pure: the same frame and
//! theme always produce the same ops, which is what the fixture tests pin.

pub mod color;
pub mod links;
pub mod paint;
pub mod theme;
pub mod width;

pub use paint::{
    paint, BgRun, CursorOp, DecorationKind, DecorationOp, DrawOp, GlyphOp, Highlight, HighlightKind,
};
pub use theme::{Rgb, Theme};
