//! The offer stream. Pairfob writes one JSON object per line: `offer`, then
//! `ready` when a device completes the handshake, then `paired`; `error`
//! carries a human message. Closing stdin cancels.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::{unbounded, Receiver, RecvTimeoutError, Sender};
use serde::Deserialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub reference: String,
    pub url: String,
    pub code: String,
    pub location: Option<String>,
    pub host: Option<String>,
    pub expires_at: Option<SystemTime>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OfferEvent {
    Offer(Offer),
    Ready,
    Paired,
    Cancelled,
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QrMatrix {
    pub width: usize,
    modules: Vec<bool>,
}

impl QrMatrix {
    pub fn get(&self, x: usize, y: usize) -> bool {
        self.modules
            .get(y * self.width + x)
            .copied()
            .unwrap_or(false)
    }

    pub fn from_modules(width: usize, modules: Vec<bool>) -> Self {
        Self { width, modules }
    }
}

impl Offer {
    /// Seconds left on the one-use code, for the countdown.
    pub fn remaining(&self, now: SystemTime) -> Option<Duration> {
        let expires = self.expires_at?;
        expires.duration_since(now).ok()
    }

    /// The QR carries the pair URL: it opens the PWA with the code already in
    /// the fragment. The short code stays visible as the fallback.
    ///
    /// When the daemon sent no URL, the code itself is encoded so the view
    /// still has something to show.
    pub fn qr_matrix(&self) -> Result<QrMatrix, PairingError> {
        let payload = if self.url.is_empty() {
            self.code.as_str()
        } else {
            self.url.as_str()
        };
        if payload.is_empty() {
            return Err(PairingError::Qr("nothing to encode".to_owned()));
        }

        let symbol = qrcode::QrCode::new(payload.as_bytes())
            .map_err(|err| PairingError::Qr(err.to_string()))?;
        let symbol_width = symbol.width();
        let colors = symbol.to_colors();

        // The UI draws plain squares, so the quiet zone is part of the matrix.
        const QUIET: usize = 4;
        let width = symbol_width + QUIET * 2;
        let mut modules = vec![false; width * width];
        for y in 0..symbol_width {
            for x in 0..symbol_width {
                if colors[y * symbol_width + x] == qrcode::Color::Dark {
                    modules[(y + QUIET) * width + (x + QUIET)] = true;
                }
            }
        }
        Ok(QrMatrix { width, modules })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error("could not start pairfob: {0}")]
    Spawn(String),
    #[error("the pairing offer ended: {0}")]
    Failed(String),
    #[error("could not encode the QR code: {0}")]
    Qr(String),
    #[error("the pairing process is gone")]
    Closed,
}

#[derive(Deserialize)]
struct WireEvent {
    event: String,
    #[serde(default, rename = "pair_ref")]
    reference: Option<String>,
    #[serde(default, rename = "pair_url")]
    url: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default, rename = "pair_loc")]
    location: Option<String>,
    #[serde(default, rename = "expires_at")]
    expires_at: Option<String>,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// Returns the event to publish and whether it ends the offer.
fn parse_line(line: &str) -> Option<(OfferEvent, bool)> {
    let wire: WireEvent = serde_json::from_str(line.trim()).ok()?;
    let event = match wire.event.as_str() {
        "offer" => OfferEvent::Offer(Offer {
            reference: wire.reference.unwrap_or_default(),
            url: wire.url.unwrap_or_default(),
            code: wire.code.unwrap_or_default(),
            location: wire.location.filter(|value| !value.is_empty()),
            host: wire.host.filter(|value| !value.is_empty()),
            expires_at: wire.expires_at.as_deref().and_then(parse_time),
        }),
        "ready" => OfferEvent::Ready,
        "paired" => return Some((OfferEvent::Paired, true)),
        "error" => {
            return Some((OfferEvent::Failed(wire.message.unwrap_or_default()), true));
        }
        _ => return None,
    };
    Some((event, false))
}

fn parse_time(text: &str) -> Option<SystemTime> {
    OffsetDateTime::parse(text, &Rfc3339)
        .ok()
        .map(SystemTime::from)
}

enum Signal {
    /// The reader saw the end of stdout; every line has already been published.
    Eof,
    Cancel,
}

struct Controller {
    child: Child,
    signals: Receiver<Signal>,
    events: Sender<OfferEvent>,
    cancelled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    done: Sender<()>,
}

impl Controller {
    fn run(mut self) {
        let tick = Duration::from_millis(10);
        let grace = Duration::from_secs(1);
        let mut reader_done = false;
        let mut reaped = false;
        let mut cancel_started: Option<Instant> = None;
        let mut cancel_requested = false;
        let mut killed = false;

        loop {
            match self.signals.recv_timeout(tick) {
                Ok(Signal::Eof) => reader_done = true,
                Ok(Signal::Cancel) => {
                    cancel_requested = true;
                    cancel_started.get_or_insert_with(Instant::now);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => reader_done = true,
            }

            if !reaped {
                match self.child.try_wait() {
                    Ok(Some(_)) => reaped = true,
                    Ok(None) => {}
                    Err(_) => reaped = true,
                }
            }

            if cancel_requested && !killed && !reaped {
                if let Some(start) = cancel_started {
                    if start.elapsed() >= grace {
                        let _ = self.child.kill();
                        killed = true;
                    }
                }
            }

            if reader_done && reaped {
                break;
            }

            // A child that swallowed its kill must not hold the window forever.
            if killed && !reader_done {
                if let Some(start) = cancel_started {
                    if start.elapsed() >= grace * 2 {
                        break;
                    }
                }
            }
        }

        // Reap before reporting so no zombie outlives the session.
        if !reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }

        if self.cancelled.load(Ordering::Acquire) {
            let _ = self.events.send(OfferEvent::Cancelled);
        }
        drop(self.events);
        self.finished.store(true, Ordering::Release);
        let _ = self.done.send(());
    }
}

pub struct OfferSession {
    events: Receiver<OfferEvent>,
    stdin: Mutex<Option<ChildStdin>>,
    signals: Sender<Signal>,
    done: Receiver<()>,
    terminal: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    cancel_sent: AtomicBool,
}

impl OfferSession {
    pub fn start(pairfob: &Path) -> Result<Self, PairingError> {
        let mut child = Command::new(pairfob)
            .arg("pair")
            .arg("offer")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| PairingError::Spawn(err.to_string()))?;

        let stdin = child.stdin.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            PairingError::Spawn("standard input is unavailable".to_owned())
        })?;
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(PairingError::Spawn(
                    "standard output is unavailable".to_owned(),
                ));
            }
        };
        if let Some(stderr) = child.stderr.take() {
            // Draining without keeping or logging keeps a full pipe from
            // blocking the child; its text may name the operator's machine.
            thread::spawn(move || {
                let mut sink = String::new();
                let _ = BufReader::new(stderr).read_to_string(&mut sink);
            });
        }

        let (events, event_rx) = unbounded();
        let (signals, signal_rx) = unbounded();
        let (done, done_rx) = unbounded();
        let terminal = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));

        {
            let events = events.clone();
            let signals = signals.clone();
            let terminal = Arc::clone(&terminal);
            thread::spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if let Some((event, ends)) = parse_line(&line) {
                                if ends {
                                    terminal.store(true, Ordering::Release);
                                }
                                if events.send(event).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
                // Publish everything before the reaper is allowed to finish.
                drop(events);
                let _ = signals.send(Signal::Eof);
            });
        }

        let controller = Controller {
            child,
            signals: signal_rx,
            events,
            cancelled: Arc::clone(&cancelled),
            finished: Arc::clone(&finished),
            done,
        };
        thread::spawn(move || controller.run());

        Ok(Self {
            events: event_rx,
            stdin: Mutex::new(Some(stdin)),
            signals,
            done: done_rx,
            terminal,
            cancelled,
            finished,
            cancel_sent: AtomicBool::new(false),
        })
    }

    pub fn events(&self) -> Receiver<OfferEvent> {
        self.events.clone()
    }

    /// Closing stdin is the operator walking away: pairfob denies the slot.
    pub fn cancel(&self) {
        if self.finished.load(Ordering::Acquire) {
            return;
        }
        let first = !self.cancel_sent.swap(true, Ordering::AcqRel);
        // Queue the intent before stdin closes: the child may exit on that
        // close and its EOF would otherwise reach the controller first.
        if first {
            // The child reports "pairing cancelled" as an error once stdin
            // closes, so ask for `Cancelled` based on the state before that.
            if !self.terminal.load(Ordering::Acquire) {
                self.cancelled.store(true, Ordering::Release);
            }
            let _ = self.signals.send(Signal::Cancel);
        }
        if let Ok(mut stdin) = self.stdin.lock() {
            drop(stdin.take());
        }
        // The controller kills at one second; the extra second is for the
        // after-kill reap and the final event.
        let _ = self.done.recv_timeout(Duration::from_secs(3));
    }
}

impl Drop for OfferSession {
    fn drop(&mut self) {
        self.cancel();
    }
}
