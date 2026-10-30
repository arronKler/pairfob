//! The pairing sheet's state and the process that feeds it. `pairfob pair
//! offer` is long-running and its cancel waits for the child, so the session
//! lives on a worker thread; the window only polls it.

use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::{unbounded, Receiver, RecvTimeoutError, Sender, TryRecvError};

use crate::pairing::{Offer, OfferEvent, OfferSession, QrMatrix};

const WORKER_POLL: Duration = Duration::from_millis(50);
const PAIRED_HOLD: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairingState {
    Starting,
    Offer,
    Ready,
    Paired,
    Failed(String),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PairingUpdate {
    pub changed: bool,
    pub close: bool,
}

pub struct PairingSheet {
    pub state: PairingState,
    pub offer: Option<Offer>,
    pub matrix: Option<QrMatrix>,
    /// Whole seconds left on the code, rounded up. `None` when the daemon did
    /// not say when it expires.
    pub seconds: Option<u64>,
    paired_at: Option<Instant>,
    events: Receiver<OfferEvent>,
    cancel: Sender<()>,
}

impl PairingSheet {
    /// A sheet with an invented code, so the shot build can render the overlay
    /// without starting a real offer.
    #[cfg(feature = "shot")]
    pub fn fixture() -> Self {
        let (out, events) = unbounded();
        let (cancel, _cancelled) = unbounded();
        // The sheet treats a closed channel as a dead worker, so the fixture
        // keeps its sender alive on a parked thread.
        thread::spawn(move || {
            let _out = out;
            std::thread::park();
        });
        let offer = Offer {
            reference: "fixture".into(),
            url: "https://pairfob.com/pair#fixture".into(),
            code: "7QK2M9".into(),
            location: None,
            host: None,
            expires_at: Some(SystemTime::now() + Duration::from_secs(115)),
        };
        Self {
            state: PairingState::Offer,
            matrix: offer.qr_matrix().ok(),
            seconds: Some(115),
            offer: Some(offer),
            paired_at: None,
            events,
            cancel,
        }
    }

    pub fn start(pairfob: PathBuf) -> Self {
        let (out, events) = unbounded();
        let (cancel, cancelled) = unbounded();
        thread::spawn(move || worker(pairfob, out, cancelled));
        Self {
            state: PairingState::Starting,
            offer: None,
            matrix: None,
            seconds: None,
            paired_at: None,
            events,
            cancel,
        }
    }

    /// Closing the sheet is cancellation. The worker reaps the child; this
    /// call never waits for it.
    pub fn cancel(&self) {
        let _ = self.cancel.send(());
    }

    pub fn countdown(&self) -> String {
        super::layout::countdown(self.seconds.map(Duration::from_secs))
    }

    pub fn poll(&mut self, now: SystemTime) -> PairingUpdate {
        let mut changed = false;
        let mut close = false;

        loop {
            match self.events.try_recv() {
                Ok(event) => {
                    changed = true;
                    match event {
                        OfferEvent::Offer(offer) => {
                            self.matrix = offer.qr_matrix().ok();
                            self.seconds = whole_seconds(offer.remaining(now));
                            self.offer = Some(offer);
                            self.state = PairingState::Offer;
                        }
                        OfferEvent::Ready => self.state = PairingState::Ready,
                        OfferEvent::Paired => {
                            self.state = PairingState::Paired;
                            self.paired_at.get_or_insert_with(Instant::now);
                        }
                        OfferEvent::Cancelled => close = true,
                        OfferEvent::Failed(message) => self.state = PairingState::Failed(message),
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    // The worker exits after sending a terminal event, so a
                    // disconnect without one means the child died.
                    if matches!(
                        self.state,
                        PairingState::Starting | PairingState::Offer | PairingState::Ready
                    ) {
                        self.state = PairingState::Failed("The pairing process ended.".to_owned());
                        changed = true;
                    }
                    break;
                }
            }
        }

        if matches!(self.state, PairingState::Offer | PairingState::Ready) {
            if let Some(offer) = &self.offer {
                let remaining = offer.remaining(now);
                let seconds = whole_seconds(remaining);
                if seconds != self.seconds {
                    self.seconds = seconds;
                    changed = true;
                }
                // A missing expiry means the daemon did not send one, not
                // that the code has already lapsed.
                if offer.expires_at.is_some() && remaining.is_none() {
                    self.state = PairingState::Failed(
                        "This pairing code expired. Start a new pairing.".to_owned(),
                    );
                    changed = true;
                }
            }
        }

        if self.paired_at.is_some_and(|at| at.elapsed() >= PAIRED_HOLD) {
            close = true;
        }

        PairingUpdate { changed, close }
    }
}

fn whole_seconds(remaining: Option<Duration>) -> Option<u64> {
    remaining.map(|remaining| remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0))
}

fn worker(pairfob: PathBuf, out: Sender<OfferEvent>, cancel: Receiver<()>) {
    let session = match OfferSession::start(&pairfob) {
        Ok(session) => session,
        Err(error) => {
            let _ = out.send(OfferEvent::Failed(error.to_string()));
            return;
        }
    };
    let events = session.events();
    loop {
        match cancel.try_recv() {
            Ok(()) => {
                session.cancel();
                return;
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                session.cancel();
                return;
            }
        }
        match events.recv_timeout(WORKER_POLL) {
            Ok(event) => {
                let terminal = matches!(
                    event,
                    OfferEvent::Paired | OfferEvent::Cancelled | OfferEvent::Failed(_)
                );
                let _ = out.send(event);
                if terminal {
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer(expires_at: Option<SystemTime>) -> Offer {
        Offer {
            reference: "ref".into(),
            url: "https://pairfob.com/pair#code".into(),
            code: "ABC123".into(),
            location: None,
            host: None,
            expires_at,
        }
    }

    fn sheet(state: PairingState, offer: Offer) -> (PairingSheet, Sender<OfferEvent>) {
        let (out, events) = unbounded();
        let (cancel, _cancelled) = unbounded();
        let sheet = PairingSheet {
            state,
            offer: Some(offer),
            matrix: None,
            seconds: None,
            paired_at: None,
            events,
            cancel,
        };
        (sheet, out)
    }

    #[test]
    fn a_code_without_an_expiry_does_not_lapse() {
        let (mut sheet, _out) = sheet(PairingState::Offer, offer(None));
        let update = sheet.poll(SystemTime::now());
        assert_eq!(sheet.state, PairingState::Offer);
        assert!(!update.close);
        assert_eq!(sheet.seconds, None);
    }

    #[test]
    fn an_expired_code_says_so_instead_of_waiting_forever() {
        let past = SystemTime::now() - Duration::from_secs(1);
        let (mut sheet, _out) = sheet(PairingState::Offer, offer(Some(past)));
        sheet.poll(SystemTime::now());
        assert!(matches!(sheet.state, PairingState::Failed(_)));
    }

    #[test]
    fn the_countdown_rounds_up_to_whole_seconds() {
        assert_eq!(whole_seconds(Some(Duration::from_millis(1))), Some(1));
        assert_eq!(whole_seconds(Some(Duration::from_secs(90))), Some(90));
        assert_eq!(whole_seconds(None), None);
    }

    #[test]
    fn a_paired_sheet_closes_itself_after_the_hold() {
        let (_out, events) = unbounded::<OfferEvent>();
        let (cancel, _cancelled) = unbounded();
        let mut sheet = PairingSheet {
            state: PairingState::Paired,
            offer: Some(offer(None)),
            matrix: None,
            seconds: None,
            paired_at: Some(Instant::now() - PAIRED_HOLD),
            events,
            cancel,
        };
        assert!(sheet.poll(SystemTime::now()).close);
    }
}
