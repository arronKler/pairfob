import type { AgentTraceViewport } from "../../../lib/agent-trace-cache";

const MAX_SCROLL_PX = 10_000_000;

function bounded(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_SCROLL_PX, Math.min(MAX_SCROLL_PX, value));
}

function anchorNodes(stream: HTMLElement): HTMLElement[] {
  return [...stream.querySelectorAll<HTMLElement>("[data-trace-anchor]")];
}

function relativeTop(stream: HTMLElement, node: HTMLElement): number {
  const streamRect = stream.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  if (streamRect.height || nodeRect.height || nodeRect.top || streamRect.top) return nodeRect.top - streamRect.top;
  return node.offsetTop - stream.scrollTop;
}

/** Capture plain, bounded viewport data. No DOM node escapes into the trace cache. */
export function captureTraceViewport(
  stream: HTMLElement,
  follow: boolean,
  unread: boolean,
  edge: "start" | "end" = "start",
): AgentTraceViewport {
  const at = { scrollTop: bounded(stream.scrollTop), follow, unread, edge };
  // A following reader is restored to the tail, so its anchor is never read.
  // Measuring one node per turn would cost a layout pass on every poll.
  if (follow) return { anchor: "", offset: 0, ...at };
  const nodes = anchorNodes(stream);
  // One box for the scrollport, and one per node: a repeating read of the same
  // rect costs a call and an object each time on a long transcript.
  let streamRect: DOMRect | null = null;
  const streamBox = (): DOMRect => (streamRect ??= stream.getBoundingClientRect());
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    const measurable = Boolean(rect.height || rect.top || streamBox().height || node.offsetHeight || node.offsetTop);
    if (!measurable) continue;
    const box = streamBox();
    const top = box.height || rect.height || rect.top || box.top ? rect.top - box.top : node.offsetTop - stream.scrollTop;
    const height = rect.height || node.offsetHeight;
    if (top + height > 0 || node === nodes[nodes.length - 1]) {
      const anchor = node.dataset.traceAnchor || "";
      const ordinal = Number(node.dataset.traceOrdinal);
      const ordinalFromEnd = Number(node.dataset.traceOrdinalEnd);
      return {
        anchor: anchor.slice(0, 512),
        offset: bounded(top),
        ...at,
        ...(Number.isSafeInteger(ordinal) ? { ordinal } : {}),
        ...(Number.isSafeInteger(ordinalFromEnd) ? { ordinalFromEnd } : {}),
      };
    }
  }
  return { anchor: "", offset: 0, ...at };
}

/** Restore an anchor after React has committed changed/prepended transcript content. */
export function restoreTraceViewport(stream: HTMLElement, viewport: AgentTraceViewport): boolean {
  if (viewport.follow) {
    stream.scrollTop = stream.scrollHeight;
    return true;
  }
  const matches = viewport.anchor
    ? anchorNodes(stream).filter((node) => node.dataset.traceAnchor === viewport.anchor)
    : [];
  const ordinal = viewport.edge === "end" ? viewport.ordinalFromEnd : viewport.ordinal;
  const anchor = ordinal === undefined
    ? matches[0]
    : matches.find((node) => Number(
      viewport.edge === "end" ? node.dataset.traceOrdinalEnd : node.dataset.traceOrdinal,
    ) === ordinal);
  if (!anchor) {
    stream.scrollTop = bounded(viewport.scrollTop);
    return false;
  }
  stream.scrollTop = bounded(stream.scrollTop + relativeTop(stream, anchor) - viewport.offset);
  return true;
}
