import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  chatDetailsOwner,
  choiceFromDetails,
  recordChatDetailChoice,
  type DetailsState,
} from "./details";

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
  const owner = useRef(chatDetailsOwner());
  const [choice, setChoice] = useState<boolean | null>(() => choiceFromDetails(kept, traceKey));
  const opened = choice ?? auto;
  const latestOpen = useRef(onOpen);
  const openedByUser = useRef(false);
  latestOpen.current = onOpen;
  const live = () => owner.current === chatDetailsOwner();
  useLayoutEffect(() => {
    let retired = false;
    const alreadyRequested = openedByUser.current;
    openedByUser.current = false;
    if (opened && onOpen && !alreadyRequested) queueMicrotask(() => {
      if (!retired && live() && element.current?.isConnected && element.current.open) latestOpen.current?.("automatic");
    });
    return () => { retired = true; };
  }, [opened, onOpen]);
  return <details ref={element} className={className} open={opened} data-key={traceKey}
    data-auto-open={choice === null && auto ? "1" : undefined}
    data-user={choice === null ? undefined : choice ? "open" : "closed"}
    onToggle={event => {
      if (!live()) return;
      const next = event.currentTarget.open;
      if (next !== opened) {
        setChoice(next);
        recordChatDetailChoice(traceKey, next, owner.current);
      }
      if (next && next !== opened) {
        openedByUser.current = true;
        latestOpen.current?.("toggle");
      }
    }}>
    {children}
  </details>;
}
