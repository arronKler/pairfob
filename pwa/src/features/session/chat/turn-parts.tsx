import { Check, ChevronsDownUp, Copy, Paperclip, SquareTerminal } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import type { AgentTraceItem } from "../../../lib/operations";
import { Button, Spinner } from "../../../shared/ui/primitives";
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

function PromptBubble({ text, anchorData }: { text: string; anchorData: TraceAnchorData }) {
  const { body, files } = splitAttachments(text);
  const textRef = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node) return;
    const line = parseFloat(node.ownerDocument.defaultView?.getComputedStyle(node).lineHeight ?? "") || 21;
    setLong(node.scrollHeight > line * PROMPT_LINES + 2);
  }, [body]);
  return <article className="agent-user" {...anchorData}>
    {body && <div ref={textRef} className={`agent-user-text${long && !open ? " is-clamped" : ""}`}>{body}</div>}
    {long && <Button className="agent-user-more" aria-expanded={open} onClick={() => setOpen(!open)}>
      {t(open ? "prompt.collapse" : "prompt.expand")}</Button>}
    {files.length > 0 && <ul className="agent-user-files">{files.map((name, index) =>
      <li key={index} aria-label={t("prompt.attachment", { name })}><Paperclip size={12} aria-hidden="true" /><span>{name}</span></li>)}</ul>}
  </article>;
}

export function TurnHead({ item, anchorData }: { item: AgentTraceItem; anchorData: TraceAnchorData }) {
  const text = item.text || "";
  if (item.type === "command") {
    return <article className="agent-command" {...anchorData} aria-label={t("trace.commandAria", { cmd: text })}>
      <SquareTerminal className="agent-command-icon" size={13} aria-hidden="true" />
      <code className="agent-command-text">{text}</code>
    </article>;
  }
  return <PromptBubble text={text} anchorData={anchorData} />;
}

export function ReplyActions({ text, onCopy }: { text: string; onCopy?: (text: string) => unknown }) {
  const [copied, confirm] = useCopied();
  if (!onCopy || !text) return null;
  const copy = (): void => {
    void Promise.resolve(onCopy(text)).then((done) => { if (done === true) confirm("done"); });
  };
  return <div className="agent-reply-actions">
    <Button className="agent-reply-copy" data-copied={copied ? "" : undefined}
      aria-label={t(copied ? "chat.copiedReply" : "chat.copyReplyAria")} onClick={copy}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {t(copied ? "reply.copied" : "reply.copy")}</Button>
  </div>;
}

/** Delivery state for a prompt the transcript has not recorded yet. */
export function PendingCard({ message, attention, settled }: { message: string; attention: boolean; settled: boolean }) {
  return <div className={`pending-card${attention ? " is-attention" : ""}`} role="status" aria-live="polite" data-prompt-progress="">
    {!settled && !attention && <Spinner />}
    <span>{message}</span>
  </div>;
}

export function CompactionDivider() {
  return <div className="agent-marker agent-marker-compaction" role="note">
    <ChevronsDownUp size={14} aria-hidden="true" /><span>{t("trace.compacted")}</span>
  </div>;
}
