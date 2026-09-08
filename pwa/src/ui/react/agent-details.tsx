import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DetailsState } from "../agent-chat-stream";

type AgentDetailsProps = {
  traceKey: string; className: string; auto?: boolean; kept?: DetailsState;
  onOpen?: (source: "automatic" | "toggle") => void; children: ReactNode;
};

/** A different trace entry must not inherit the preceding tool's manual choice. */
export function AgentDetails(props: AgentDetailsProps) {
  return <DetailsStateView key={props.traceKey} {...props} />;
}

function DetailsStateView({ traceKey, className, auto = false, kept, onOpen, children }: AgentDetailsProps) {
  const element = useRef<HTMLDetailsElement>(null);
  const [choice, setChoice] = useState<boolean | null>(() => kept?.closed.has(traceKey) ? false
    : kept?.open.has(traceKey) ? true : null);
  const opened = choice ?? auto;
  const latestOpen = useRef(onOpen);
  const openedByUser = useRef(false);
  latestOpen.current = onOpen;
  useLayoutEffect(() => {
    let retired = false;
    const alreadyRequested = openedByUser.current;
    openedByUser.current = false;
    if (opened && onOpen && !alreadyRequested) queueMicrotask(() => {
      if (!retired && element.current?.isConnected && element.current.open) latestOpen.current?.("automatic");
    });
    return () => { retired = true; };
  }, [opened, onOpen]);
  return <details ref={element} className={className} open={opened} data-key={traceKey}
    data-auto-open={choice === null && auto ? "1" : undefined}
    data-user={choice === null ? undefined : choice ? "open" : "closed"}
    onToggle={event => {
      const next = event.currentTarget.open;
      if (next !== opened) setChoice(next);
      if (next && next !== opened) {
        openedByUser.current = true;
        latestOpen.current?.("toggle");
      }
    }}>
    {children}
  </details>;
}
