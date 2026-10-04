import { SquareTerminal, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { t } from "../../../lib/i18n";
import type { PendingAsk } from "../../../lib/agent-trace-steps";
import { dialogKeys, MAX_DIALOG_KEYS, parseTerminalDialog, screenExcerpt } from "../../../lib/terminal-dialog";
import { ProtocolError } from "../../../lib/protocol/errors";
import { messageOf } from "../../../lib/notices";
import { liveSession } from "../../computers/catalog-store";
import { useSession } from "../hooks";
import { Button, Spinner } from "../../../shared/ui/primitives";

/** Must match the daemon's guarded read (internal/daemon/rpc_input.go guardedPaneReadLines). */
const GUARDED_LINES = 80;
/** Re-reads after an answer, for a follow-up prompt the status poll has not seen yet. */
const FOLLOW_UP_READS_MS = [1500, 4000];

/** Must match the stream's own "at the latest turn" slack (agent-stream onScroll). */
const TAIL_SLACK_PX = 32;

/**
 * The card grows once its screen read lands, after the stream already settled
 * on the latest turn. A reader who was there stays there, so the choices are
 * not pushed below the fold; a reader further up is left alone.
 */
function useKeepTail(card: RefObject<HTMLElement | null>): void {
  const height = useRef(0);
  useLayoutEffect(() => {
    const node = card.current;
    const stream = node?.closest<HTMLElement>(".agent-stream");
    if (!node) return;
    const next = node.getBoundingClientRect().height;
    const grew = next - height.current;
    const first = height.current === 0;
    height.current = next;
    if (first || grew <= 0 || !stream) return;
    if (stream.scrollHeight - grew - stream.scrollTop - stream.clientHeight < TAIL_SLACK_PX) stream.scrollTop = stream.scrollHeight;
  });
}

type Screen = { text: string; hash?: string };
type Phase = "reading" | "ready" | "sending" | "sent";

/**
 * The agent stopped for the reader. The terminal's own prompt is what it waits
 * on, so the screen leads; the transcript's pending tool only fills in when the
 * screen shows no list. A numbered choice is answered here: the keys go with
 * the screen's hash and question, so the daemon refuses them if the prompt
 * changed since the reader saw it. Nothing retries; any failure only re-reads.
 */
export function NeedsYouCard({ ask, onTerminal, onAnswered }: {
  ask: PendingAsk | null; onTerminal?: () => void; onAnswered?: () => void;
}) {
  const paneId = useSession().paneId;
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  useKeepTail(card);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [phase, setPhase] = useState<Phase>("reading");
  const [choice, setChoice] = useState<number | null>(null);
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
  const live = useRef({ mounted: true, phase: "reading" as Phase, hash: "", answered: "", stale: 0, timers: [] as number[] });
  live.current.phase = phase;
  useEffect(() => () => {
    live.current.mounted = false;
    for (const timer of live.current.timers) clearTimeout(timer);
  }, []);

  const read = useCallback(async () => {
    const session = liveSession();
    // Offline there is nothing to read; the card falls back to its generic line.
    if (!session || !paneId) { setPhase("ready"); return; }
    if (live.current.phase !== "sent") setPhase("reading");
    try {
      const view = await session.paneRead(paneId, GUARDED_LINES, "text");
      // A send in flight owns the card; its own outcome decides what comes next.
      if (!live.current.mounted || live.current.phase === "sending") return;
      const changed = view.hash !== live.current.hash;
      live.current.hash = view.hash ?? "";
      setScreen({ text: view.text, hash: view.hash });
      if (changed) {
        setChoice(null);
        // A new prompt replaced the one answered: its "sent" note no longer applies.
        if (live.current.phase === "sent") setNote(null);
      }
      // After an answer the same screen stays locked, so the answer cannot go twice.
      const answeredScreen = Boolean(live.current.answered) && view.hash === live.current.answered;
      setPhase(live.current.phase === "sent" && answeredScreen ? "sent" : "ready");
    } catch (failure) {
      if (!live.current.mounted || live.current.phase === "sending") return;
      setNote({ text: messageOf(failure, "read"), warn: true });
      setPhase("ready");
    }
  }, [paneId]);
  useEffect(() => { void read(); }, [read]);

  const dialog = screen ? parseTerminalDialog(screen.text) : null;
  const send = async () => {
    const session = liveSession();
    if (!session || !paneId || !dialog || !screen?.hash || choice === null) return;
    const keys = dialogKeys(dialog, choice);
    if (keys.length > MAX_DIALOG_KEYS) { setNote({ text: t("needs.tooFar"), warn: true }); return; }
    for (const timer of live.current.timers.splice(0)) clearTimeout(timer);
    setPhase("sending");
    live.current.phase = "sending";
    setNote(null);
    try {
      await session.sendKeys(paneId, keys, {
        intent: "dialog", expected_prompt: dialog.question || dialog.options[0].label, expected_signature: screen.hash,
      });
      if (!live.current.mounted) return;
      live.current.answered = screen.hash;
      live.current.stale = 0;
      setPhase("sent");
      live.current.phase = "sent";
      setNote({ text: t("needs.sent"), warn: false });
      onAnswered?.();
      live.current.timers = FOLLOW_UP_READS_MS.map((delay) => window.setTimeout(() => { if (live.current.mounted) void read(); }, delay));
    } catch (failure) {
      if (!live.current.mounted) return;
      const stale = failure instanceof ProtocolError && failure.code === "stale_prompt";
      live.current.stale = stale ? live.current.stale + 1 : 0;
      // A screen that keeps changing (a ticking line) cannot be answered from here.
      setNote({ text: stale ? t(live.current.stale > 1 ? "needs.unstable" : "needs.stale") : messageOf(failure), warn: true });
      setChoice(null);
      setPhase("ready");
      live.current.phase = "ready";
      live.current.hash = "";
      void read();
    }
  };

  const busy = phase === "sending" || phase === "sent";
  const excerpt = !dialog && screen ? screenExcerpt(screen.text) : [];
  return <section ref={card} className="needs-card" aria-labelledby={titleId}>
    <p className="needs-title" id={titleId}><TriangleAlert size={16} aria-hidden="true" />{t("needs.title")}</p>
    {dialog ? <>
      {dialog.context.length > 0 && <pre className="needs-screen" aria-label={t("needs.screenAria")}>{dialog.context.join("\n")}</pre>}
      <fieldset className="needs-dialog" disabled={busy}>
        <legend className="needs-question">{dialog.question}</legend>
        {dialog.options.map((option) => <Button key={option.number} aria-pressed={choice === option.number}
          className={`needs-option${choice === option.number ? " is-chosen" : ""}`}
          onClick={() => { setChoice(option.number); setNote(null); }}>
          <span className="needs-option-number">{option.number}</span><span>{option.label}</span>
        </Button>)}
      </fieldset>
    </> : <>
      {ask && <div className="needs-ask"><span className="needs-verb">{ask.verb}</span><code className="needs-object">{ask.object}</code></div>}
      {excerpt.length > 0 ? <pre className="needs-screen" aria-label={t("needs.screenAria")}>{excerpt.join("\n")}</pre>
        : !ask && phase !== "reading" ? <p className="needs-generic">{t("needs.generic")}</p> : null}
    </>}
    {phase === "reading" && !screen && <p className="needs-note"><Spinner />{t("needs.reading")}</p>}
    {note && <p className={`needs-note${note.warn ? " is-warn" : ""}`} role={note.warn ? "alert" : "status"}>{note.text}</p>}
    <div className="needs-actions">
      {dialog && <Button className="btn btn-primary btn-small needs-send" disabled={choice === null || busy || !screen?.hash}
        onClick={() => void send()}>{phase === "sending" ? t("needs.sending") : t("needs.send")}</Button>}
      {onTerminal && <Button className={`btn btn-small needs-go${dialog ? "" : " btn-primary"}`} onClick={onTerminal}>
        <SquareTerminal size={15} aria-hidden="true" />{t("needs.go")}</Button>}
    </div>
  </section>;
}
