import type { ReactNode } from "react";
import { sessionViewKind, type SessionViewKind } from "../../features/session/model";

export { sessionViewKind };

/**
 * Page composition for guided / agent chat / full terminal.
 * Callers pass already-built views; this file does not import state or paint.
 */
export function SessionScreen({
  kind,
  guided,
  chat,
  terminal,
}: {
  kind: SessionViewKind;
  guided: ReactNode;
  chat: ReactNode;
  terminal: ReactNode;
}) {
  if (kind === "full") return terminal;
  if (kind === "agent") return chat;
  return guided;
}
