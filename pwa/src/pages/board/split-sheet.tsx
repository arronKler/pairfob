import { useEffect, useRef, useState } from "react";
import { agentTitle, type DashboardAgentCard } from "../../lib/dashboard";
import { t } from "../../lib/i18n";
import type { SplitDirection } from "../../lib/operations";
import { highlightBoardPane } from "../../features/board/interaction-store";
import { AgentKindGrid, kindName } from "../../features/operations/agent-kind-grid";
import { AgentKindPickerPanel } from "../../features/operations/agent-kind-picker";
import { advertisedAgentKinds } from "../../features/operations/capabilities-store";
import { splitSelectedPane, type SheetOutcome } from "../../features/operations/controller";
import { loadCreateMemory, rememberCreate } from "../../features/operations/create-memory";
import { defaultAgentKind, loadLastAgentKind } from "../../features/operations/operation-form-model";
import { useConnection } from "../../features/connection/hooks";
import { liveSession } from "../../features/computers/catalog-store";
import { useCapabilities } from "../../features/operations/hooks";
import { Button, Spinner } from "../../shared/ui/primitives";
import { showActionSheet, type ActionSheetController } from "../../shared/ui/overlay";
import { boardLayoutReason, boardPaneCard, watchBoardTarget } from "./board-layout-ops";
import { useDeskEnter } from "../../shared/ui/overlay/desk-form";
import { DeskCancel } from "../../shared/ui/overlay/modal";
import { SheetFooter } from "../../shared/ui/overlay/sheet-content";

/**
 * What to start in the new cell. Where it goes was the tap on "+" in the
 * canvas placement, so the sheet carries the session split page's fields only:
 * the shared agent grid (with the full list swapped in place), one summary and
 * one button. On success the board stays put and marks the new cell.
 */
function BoardSplitSheet({ modal, card, direction, target, reveal }: {
  modal: ActionSheetController; card: DashboardAgentCard; direction: SplitDirection;
  target: ReturnType<typeof watchBoardTarget>; reveal: (paneId: string) => void;
}) {
  const { valid } = target;
  useEffect(() => target.release, [target]);
  const [kinds] = useState(() => [...advertisedAgentKinds()]);
  const [memory, setMemory] = useState(loadCreateMemory);
  const [lastKind] = useState(() => loadLastAgentKind(kinds));
  const [kind, setKind] = useState(() => defaultAgentKind(kinds, lastKind, card.agent));
  const [picking, setPicking] = useState(false);
  const { operationBusy } = useCapabilities();
  const { networkOnline } = useConnection();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  // While this sheet's own split runs it holds the lock; the busy reason is ours, not news.
  const reason = !networkOnline || !liveSession()?.isConnected() ? t("boardMenu.offline")
    : operationBusy && !pending ? t("boardMenu.busy") : "";
  const tabId = card.tabId ?? "";
  /** One submission at a time; success closes the sheet, failure stays with the reason. */
  const run = async (work: () => Promise<SheetOutcome>) => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError("");
    try {
      const outcome = await work();
      if (outcome.ok) modal.dismiss();
      else setError(outcome.message);
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  const submit = () => {
    if (reason) return;
    void run(async () => {
      const outcome = await splitSelectedPane(card, {
        valid,
        input: { direction, ratio: 0.5, ...(kind ? { agent_kind: kind } : {}), ...(card.cwd.startsWith("/") ? { cwd: card.cwd } : {}) },
        created: (paneId) => {
          highlightBoardPane(paneId, tabId, true);
          requestAnimationFrame(() => { if (valid()) reveal(paneId); });
        },
      });
      if (outcome.ok) rememberCreate({ kind });
      return outcome;
    });
  };
  // On the desk form Enter submits from a field or a chosen kind, as in every desk dialog.
  const onEnter = useDeskEnter(submit);
  if (picking) {
    return <AgentKindPickerPanel kinds={kinds} memory={memory} selected={kind} onBack={() => setPicking(false)}
      onPick={(next) => { setKind(next); setPicking(false); }} onPinsChange={setMemory} />;
  }
  const title = agentTitle(card);
  const note = error || (pending ? "" : reason);
  return <div className="create-sheet-body board-sheet board-split" onKeyDown={onEnter}>
    <fieldset className="pane-fieldset" disabled={pending}>
      <h3 className="create-label">{t("create.what")}</h3>
      <AgentKindGrid kinds={kinds} memory={memory} selected={kind} lastKind={lastKind} onSelect={setKind} onShowAll={() => setPicking(true)} />
      {!kinds.length ? <p className="create-hint">{t("create.noKinds")}</p> : null}
      <p className="create-hint">{t("boardMenu.splitCwd")}</p>
    </fieldset>
    <SheetFooter><div className="create-footer board-split-footer">
      <p className="create-summary">
        {t(direction === "right" ? "boardMenu.splitSummaryRight" : "boardMenu.splitSummaryDown", { title, kind: kindName(kind) })}
      </p>
      {note ? <p className={`board-sheet-note${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{note}</p> : null}
      <DeskCancel disabled={pending} />
      <Button className="btn btn-primary create-submit" disabled={pending || !!reason} aria-busy={pending} onClick={submit}>
        {pending ? <><Spinner />{t("pm.creating")}</> : t("boardMenu.splitSubmit")}
      </Button>
    </div></SheetFooter>
  </div>;
}

/** Placement picked a side: ask what to start there, then split that pane. */
export function openBoardSplitSheet(paneId: string, direction: SplitDirection, reveal: (paneId: string) => void): void {
  const card = boardPaneCard(paneId);
  if (!card || boardLayoutReason("split")) return;
  const target = watchBoardTarget(paneId, card.tabId ?? "");
  showActionSheet(t("boardMenu.splitTitle"),
    (modal) => <BoardSplitSheet modal={modal} card={card} direction={direction} target={target} reveal={reveal} />,
    { subtitle: agentTitle(card), className: "board-split-sheet create-sheet" });
}
