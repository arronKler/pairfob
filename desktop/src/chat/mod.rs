//! The desktop's view of a `pairfob-chat` process: the frozen wire frames,
//! the transcript reducer, and the socket client. Nothing here knows GPUI.

pub mod attach;
pub mod state;
pub mod transport;
pub mod wire;

pub use state::{Applied, ApplyError, ChatState};
pub use transport::{attach, AttachError, ChatConnection, ChatEvent, ChatHandle};
pub use wire::Cursor;
