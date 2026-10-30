//! The only module that knows the Herdr endpoint protocol. It connects,
//! reconnects, maps wire events into [`crate::model`], and sends input through
//! the focus gate in [`crate::app::input`].

pub mod connect;
pub mod engine;
mod keys;
pub mod map;
mod reader;
mod scroll;
pub mod search;
mod selfcheck;
mod surface_patch;
pub mod wire;

pub use connect::{
    connect, ClientEvent, ConnectError, ConnectOptions, ConnectTarget, Connection, ConnectionHandle,
};
pub use engine::{start, Command, Config, Desktop, EngineError, EngineHandle};
pub(crate) use scroll::scroll_events;
pub use selfcheck::{self_check, SelfCheck};
