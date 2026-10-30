//! The desktop client. Herdr owns the panes and the programs inside them; this
//! crate attaches to the same endpoint protocol the Herdr app uses, paints the
//! cell frames, and sends keys back.
//!
//! The layers do not leak into each other:
//!
//! - [`model`] is the vocabulary (sessions, frames, cells). No wire or UI types.
//! - [`herdr`] is the only place that knows `herdr` endpoint contract.
//! - [`terminal`] turns a frame into draw instructions. No GPUI.
//! - [`chat`] is the desktop's observer of a local `pairfob-chat` process.
//! - [`devices`] reads the paired devices from the local Pairfob CLI.
//! - [`pairing`] and [`process`] own the Pairfob CLI and Herdr lifecycle.
//! - [`update`] checks the desktop release channel and replaces this build.
//! - [`ui`] is the only place that knows GPUI.

pub mod app;
pub mod chat;
pub mod devices;
pub mod herdr;
pub mod log;
pub mod model;
pub mod pairing;
pub mod process;
pub mod terminal;
pub mod update;

#[cfg(feature = "gui")]
pub mod ui;
