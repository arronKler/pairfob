//! Pairing is `pairfob pair offer` in a child process. The one-use code only
//! ever lives in memory here; it is never written to disk or logged.

pub mod offer;

pub use offer::{Offer, OfferEvent, OfferSession, PairingError, QrMatrix};
