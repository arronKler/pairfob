import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { t } from "../../lib/i18n";
import { messageOf } from "../../lib/notices";
import { parseWorktrees, type WorktreeSummary } from "../../lib/operations";
import { OperationFrame } from "./operation-form";
import { presentModal, type ModalController } from "../../shared/ui/overlay/modal";

function worktreeTitle(item: WorktreeSummary): string {
  if (item.label) return item.label;
  if (item.branch) return item.branch;
  return item.path.split(/[\\/]/).filter(Boolean).at(-1) || item.path || "Worktree";
}

function WorktreeCard({ item, actionable }: { item: WorktreeSummary; actionable: boolean }) {
  return <>
    <span className="worktree-icon" aria-hidden="true" />
    <span className="worktree-copy"><strong className="worktree-title">{worktreeTitle(item)}</strong>
      {item.label && item.branch && <span className="worktree-branch">{item.branch}</span>}
      <code className="worktree-path">{item.path}</code>
    </span>
    <span className="worktree-tail">
      {item.openWorkspaceId && <span className="worktree-opened">{t("form.worktreeOpened")}</span>}
      {actionable && <span className="worktree-chevron" aria-hidden="true">›</span>}
    </span>
  </>;
}

type WorktreeView = { items: WorktreeSummary[]; message: string; error: boolean; loading: boolean; opening: Set<WorktreeSummary> };
type WorktreeStore = { subscribe(listener: () => void): () => void; snapshot(): WorktreeView };

function WorktreesDialog({ modal, store, open }: {
  modal: ModalController<never>; store: WorktreeStore; open?: (item: WorktreeSummary) => Promise<void>;
}) {
  const view = useSyncExternalStore(store.subscribe, store.snapshot);
  return <OperationFrame modal={modal} title={t("menu.worktrees")} focusDialog>
    <div className="operation-body" aria-busy={view.loading || view.opening.size > 0}>
      <p className={`notice notice-${view.error ? "error" : "status"}`} role={view.error ? "alert" : "status"} aria-live="polite">{view.message}</p>
      <ul className="worktree-list">
        {view.items.map((item, index) => <li key={`${item.path}:${index}`} className="worktree-item">
          {open ? <button type="button" className="worktree-card" disabled={view.opening.has(item)}
            aria-label={t("form.openWorktreeNamed", { title: worktreeTitle(item) })} onClick={() => void open(item)}>
            <WorktreeCard item={item} actionable />
          </button> : <div className="worktree-card worktree-card-static"><WorktreeCard item={item} actionable={false} /></div>}
        </li>)}
      </ul>
      <button type="button" className="btn btn-small btn-ghost" onClick={modal.dismiss}>{t("close")}</button>
    </div>
  </OperationFrame>;
}

/** Load once from the caller action; closing the view retires late UI updates. */
export async function showWorktrees(load: () => Promise<unknown>, open?: (item: WorktreeSummary) => Promise<void>): Promise<void> {
  let view: WorktreeView = { items: [], message: t("form.worktreesLoading"), error: false, loading: true, opening: new Set() };
  const listeners = new Set<() => void>();
  const store: WorktreeStore = {
    snapshot: () => view,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const update = (next: Partial<WorktreeView>) => {
    if (!modal.dialog.current?.open) return;
    view = { ...view, ...next };
    flushSync(() => { for (const listener of listeners) listener(); });
  };
  const choose = open ? async (item: WorktreeSummary) => {
    if (view.opening.has(item) || !modal.dialog.current?.open) return;
    update({ opening: new Set([...view.opening, item]), error: false, message: t("form.openingNamed", { title: worktreeTitle(item) }) });
    try {
      await open(item);
      modal.dismiss();
    } catch (error) {
      const opening = new Set(view.opening);
      opening.delete(item);
      update({ opening, error: true, message: messageOf(error) });
    }
  } : undefined;
  const modal = presentModal<never>(controller => <WorktreesDialog modal={controller} store={store} open={choose} />);
  try {
    const items = parseWorktrees(await load());
    update({ items, loading: false, message: items.length ? t("form.worktreesCount", { n: items.length }) : t("form.worktreesEmpty") });
  } catch (error) {
    update({ loading: false, error: true, message: messageOf(error) });
  }
  modal.form.current?.querySelector<HTMLButtonElement>(".btn-ghost")?.focus();
}
