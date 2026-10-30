import { Check, ChevronsDownUp, Copy, Paperclip, SquareTerminal } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import type { AgentTraceItem } from "../../../lib/operations";
import { MOTION_MS, playMove } from "../../../shared/ui/dom/motion";
import { Button, CopyAck, Spinner, Swap } from "../../../shared/ui/primitives";
import { useCopied } from "../copy-confirm";

export type TraceAnchorData = { "data-trace-anchor": string; "data-trace-ordinal": number; "data-trace-ordinal-end": number };

/** Attachment paths ride at the end of a prompt (see send-gate `attachmentMessage`). */
const ATTACHMENT_PATH = /^\/\S*\/\.pairfob\/attachments\/[^/\s]+\/([^/\s]+)$/;

export function splitAttachments(text: string): { body: string; files: string[] } {
  const lines = text.split("\n");
  const files: string[] = [];
  while (lines.length) {
    const match = ATTACHMENT_PATH.exec(lines[lines.length - 1].trim());
    if (!match) break;
    files.unshift(match[1]);
    lines.pop();
  }
  return { body: files.length ? lines.join("\n").replace(/\s+$/, "") : text, files };
}

/** Prompts longer than this many lines fold behind "Show all". */
const PROMPT_LINES = 8;

function lineHeight(node: HTMLElement): number {
  return parseFloat(node.ownerDocument.defaultView?.getComputedStyle(node).lineHeight ?? "") || 21;
}

/** The prompt's text going from one height to another, clipped on the way. Null when nothing is played. */
function growText(node: HTMLElement, from: number, to: number): Animation | null {
  if (Math.abs(to - from) < 2) return null;
  return playMove(node, [{ height: `${from}px`, overflow: "hidden" }, { height: `${to}px`, overflow: "hidden" }], MOTION_MS.panel);
}

function PromptBubble({ text, anchorData, arriving }: { text: string; anchorData: TraceAnchorData; arriving: boolean }) {
  const { body, files } = splitAttachments(text);
  const textRef = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  // Shutting, the lines stay drawn while the bubble closes over them: the clamp comes when it has.
  const [closing, setClosing] = useState(false);
  const opening = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node) return;
    setLong(node.scrollHeight > lineHeight(node) * PROMPT_LINES + 2);
  }, [body]);
  // Opened: from the height the clamp gave it to the height of all its lines.
  useLayoutEffect(() => {
    const node = textRef.current;
    const was = opening.current;
    opening.current = null;
    if (node && was !== null) growText(node, was, node.getBoundingClientRect().height);
  }, [open]);
  const toggle = () => {
    const node = textRef.current;
    const was = node?.getBoundingClientRect().height ?? 0;
    if (!open) opening.current = node ? was : null;
    const move = open && node ? growText(node, was, lineHeight(node) * PROMPT_LINES) : null;
    if (move) {
      setClosing(true);
      const done = () => setClosing(false);
      move.addEventListener("finish", done);
      move.addEventListener("cancel", done);
    }
    setOpen(!open);
  };
  return <article className={`agent-user${arriving ? " rise-in" : ""}`} {...anchorData}>
    {body && <div ref={textRef} className={`agent-user-text${long && !open && !closing ? " is-clamped" : ""}`}>{body}</div>}
    {long && <Button className="agent-user-more" aria-expanded={open} onClick={toggle}>
      {t(open ? "prompt.collapse" : "prompt.expand")}</Button>}
    {files.length > 0 && <ul className="agent-user-files">{files.map((name, index) =>
      <li key={index} aria-label={t("prompt.attachment", { name })}><Paperclip size={12} aria-hidden="true" /><span>{name}</span></li>)}</ul>}
  </article>;
}

/**
 * What opened the turn. `arriving` is the stream's word that the reader sent it
 * just now: it rises into the transcript. Any other paint of it is still.
 */
export function TurnHead({ item, anchorData, arriving = false }: { item: AgentTraceItem; anchorData: TraceAnchorData; arriving?: boolean }) {
  const text = item.text || "";
  if (item.type === "command") {
    return <article className={`agent-command${arriving ? " rise-in" : ""}`} {...anchorData} aria-label={t("trace.commandAria", { cmd: text })}>
      <SquareTerminal className="agent-command-icon" size={13} aria-hidden="true" />
      <code className="agent-command-text">{text}</code>
    </article>;
  }
  return <PromptBubble text={text} anchorData={anchorData} arriving={arriving} />;
}

/** The reply's own actions. `arriving`: the turn ended in front of the reader, so they come in once the card has folded. */
export function ReplyActions({ text, onCopy, arriving = false }: { text: string; onCopy?: (text: string) => unknown; arriving?: boolean }) {
  const [copied, confirm] = useCopied();
  if (!onCopy || !text) return null;
  const copy = (): void => {
    void Promise.resolve(onCopy(text)).then((done) => { if (done === true) confirm("done"); });
  };
  return <div className={`agent-reply-actions${arriving ? " is-arriving" : ""}`}>
    <Button className="agent-quiet-pill agent-reply-copy" aria-label={t(copied ? "chat.copiedReply" : "chat.copyReplyAria")} onClick={copy}>
      <CopyAck state={copied ? "copied" : "idle"}
        idle={<><Copy size={14} aria-hidden="true" />{t("reply.copy")}</>}
        copied={<><Check size={14} aria-hidden="true" />{t("reply.copied")}</>} />
    </Button>
  </div>;
}

/**
 * Delivery state for a prompt the transcript has not recorded yet. It follows
 * its bubble in when the prompt was sent just now (`arriving`), and its words
 * swap as the delivery advances.
 */
export function PendingCard({ message, attention, settled, arriving = false }: {
  message: string; attention: boolean; settled: boolean; arriving?: boolean;
}) {
  return <div className={`pending-card${attention ? " is-attention" : ""}${arriving ? " rise-in is-following" : ""}`}
    role="status" aria-live="polite" data-prompt-progress="">
    {!settled && !attention && <Spinner />}
    <Swap on={message}>{message}</Swap>
  </div>;
}

export function CompactionDivider() {
  return <div className="agent-marker agent-marker-compaction" role="note">
    <ChevronsDownUp size={14} aria-hidden="true" /><span>{t("trace.compacted")}</span>
  </div>;
}
