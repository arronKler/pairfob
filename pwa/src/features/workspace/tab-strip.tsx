import type { KeyboardEvent } from "react";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { showWorkspaceTab } from "./actions";
import type { WorkspaceSnapshot, WorkspaceTab } from "./model";

/**
 * Files and changes as a tab list, for the screen's navigator and the
 * inspector's head. They differ in looks (`kind` names the class pair); the
 * order is the window's (`tab-order`), the same in both wherever both exist.
 *
 * One Tab stop, on the selected tab: the arrows, Home and End move between the
 * two and show the one they land on, as a tab list is expected to. Picking a
 * tab always lands on its list, so the current tab is also the way back from
 * an open file or diff.
 */
export function WorkspaceTabStrip({ snapshot, order, kind, label }: {
  snapshot: WorkspaceSnapshot; order: readonly WorkspaceTab[]; kind: "workspace" | "inspector"; label: string;
}) {
  const count = snapshot.status?.changes.length ?? 0;
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']")];
    const at = tabs.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    const to = event.key === "ArrowRight" ? (at + 1) % tabs.length
      : event.key === "ArrowLeft" ? (at + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
      : -1;
    if (to < 0) return;
    event.preventDefault();
    tabs[to].focus();
    if (order[to] !== snapshot.tab) showWorkspaceTab(order[to]);
  };
  return <div className={`${kind}-tabs`} role="tablist" aria-label={label} onKeyDown={move}>
    {order.map((tab) => {
      const on = snapshot.tab === tab;
      return <Button key={tab} className={`${kind}-tab${on ? " on" : ""}`} role="tab" aria-selected={on} tabIndex={on ? 0 : -1}
        onClick={() => showWorkspaceTab(tab)}>
        {t(tab === "changes" ? "workspace.changes" : "workspace.files")}
        {tab === "changes" && count > 0 && <span className="workspace-count">{`${count}${snapshot.status?.truncated ? "+" : ""}`}</span>}
      </Button>;
    })}
  </div>;
}
