import { ChevronRight, GitBranch, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../../../lib/i18n";
import { messageOf } from "../../../lib/notices";
import type { WorktreeSummary } from "../../../lib/operations";
import type { DashboardAgentCard as AgentCard } from "../../../lib/dashboard";
import { createPaneWorktree, loadPaneWorktrees, openPaneWorktree, type SheetOutcome } from "../../operations/controller";
import { useCapabilities } from "../../operations/hooks";
import { WorktreeCreateForm, WorktreeOpenForm } from "../../operations/worktree-forms";
import { useSheetNav } from "../../../shared/ui/overlay/sheet-stack";
import type { ActionSheetController } from "../../../shared/ui/overlay/action-sheet";
import { Button, Spinner } from "../../../shared/ui/primitives";
import { useOperationGate } from "./pane-menu-pages";
import { PanePage } from "./pane-page";

/**
 * The branch of the Worktree this pane runs in, as last listed on this phone.
 * The snapshot carries no branch, so the menu row shows it once the list has
 * been read, and nothing (rather than a guess) before that.
 */
const knownBranch = new Map<string, string>();

export function worktreeBranch(agent: AgentCard): string {
  return knownBranch.get(agent.paneId) ?? "";
}

function worktreeTitle(item: WorktreeSummary): string {
  return item.branch || item.label || item.path.split(/[\\/]/).filter(Boolean).at(-1) || item.path;
}

function isCurrent(agent: AgentCard, item: WorktreeSummary): boolean {
  const checkout = agent.worktree?.checkout_path;
  return checkout ? item.path === checkout : !!agent.workspaceId && item.openWorkspaceId === agent.workspaceId;
}

type ListState = { items: WorktreeSummary[]; loading: boolean; error: string };

/**
 * The Worktree page is the list itself: it starts loading when pushed (three
 * skeleton rows meanwhile) and a tap opens the row in place, with the row's
 * own spinner; opening closes the sheet on the new session.
 */
export function WorktreePage({ modal, agent }: { modal: ActionSheetController; agent: AgentCard }) {
  const nav = useSheetNav()!;
  const caps = useCapabilities().operationCapabilities;
  const reason = useOperationGate();
  const [list, setList] = useState<ListState>({ items: [], loading: !!caps.list_worktrees, error: "" });
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState("");
  const [openError, setOpenError] = useState("");

  useEffect(() => {
    if (!caps.list_worktrees) return;
    let live = true;
    setList(state => ({ ...state, loading: true, error: "" }));
    loadPaneWorktrees(agent).then(items => {
      if (!live) return;
      const current = items.find(item => isCurrent(agent, item));
      if (current?.branch) knownBranch.set(agent.paneId, current.branch);
      setList({ items, loading: false, error: "" });
    }, error => { if (live) setList({ items: [], loading: false, error: messageOf(error) }); });
    return () => { live = false; };
  }, [agent, attempt, caps.list_worktrees]);

  const open = async (item: WorktreeSummary) => {
    if (opening || reason) return;
    setOpening(item.path);
    setOpenError("");
    let outcome: SheetOutcome;
    try { outcome = await openPaneWorktree(agent, { path: item.path, ...(item.label ? { label: item.label } : {}) }); }
    finally { setOpening(""); }
    if (outcome.ok) modal.dismiss();
    else setOpenError(outcome.message);
  };

  return <PanePage tall className="pane-worktrees">
    {caps.create_worktree && <div className="menu-group">
      <Button className="menu-row pane-row-accent" onClick={() => nav.push({ key: "wt-new", title: t("pm.wtNew"),
        render: () => <WorktreeCreatePage modal={modal} agent={agent} /> })}>
        <span className="menu-row-icon" aria-hidden="true"><Plus size={18} /></span>
        <span className="menu-row-label">{t("pm.wtNew")}</span>
        <ChevronRight className="menu-row-next" size={18} aria-hidden="true" />
      </Button>
    </div>}
    {caps.list_worktrees && <>
      <h3 className="pane-group-title" aria-live="polite">{list.loading ? t("pm.wtLoading")
        : list.error ? "" : list.items.length ? t("pm.wtCount", { n: String(list.items.length) }) : t("form.worktreesEmpty")}</h3>
      {list.error ? <div className="pane-page-note is-error" role="alert">{list.error}{" "}
        <Button className="text-link" onClick={() => setAttempt(value => value + 1)}>{t("pm.wtRetry")}</Button></div> : null}
      {openError || (!list.loading && reason) ? <p className={`pane-page-note${openError ? " is-error" : ""}`} role={openError ? "alert" : "status"}>
        {openError || reason}</p> : null}
      <ul className="pane-wt-list" aria-busy={list.loading || !!opening}>
        {list.loading ? [0, 1, 2].map(index => <li key={index} className="pane-wt is-skeleton" aria-hidden="true">
          <span className="pane-skel" /><span className="pane-skel is-short" /></li>)
          : list.items.map((item, index) => {
            const current = isCurrent(agent, item);
            const tag = current ? t("pm.wtCurrent") : item.openWorkspaceId ? t("form.worktreeOpened") : "";
            const body = <>
              <GitBranch className="pane-wt-icon" size={18} aria-hidden="true" />
              <span className="pane-wt-text"><b>{worktreeTitle(item)}</b><small>{item.path}</small></span>
              {opening === item.path ? <Spinner /> : tag ? <span className={`pane-wt-tag${current ? " is-current" : ""}`}>{tag}</span>
                : !current && caps.open_worktree ? <ChevronRight size={18} aria-hidden="true" className="menu-row-next" /> : null}
            </>;
            return <li key={`${item.path}:${index}`}>
              {current || !caps.open_worktree ? <div className="pane-wt">{body}</div>
                : <Button className="pane-wt" disabled={!!opening || !!reason} aria-label={t("form.openWorktreeNamed", { title: worktreeTitle(item) })}
                  onClick={() => void open(item)}>{body}</Button>}
            </li>;
          })}
      </ul>
    </>}
    {caps.open_worktree && <div className="menu-group">
      <Button className="menu-row" onClick={() => nav.push({ key: "wt-open", title: t("menu.openWorktree"),
        render: () => <WorktreeOpenPage modal={modal} agent={agent} /> })}>
        <span className="menu-row-label">{t("pm.wtOpenBy")}</span>
        <ChevronRight className="menu-row-next" size={18} aria-hidden="true" />
      </Button>
    </div>}
  </PanePage>;
}

/** The shared create form as a page of the panel, on this session's repository. */
function WorktreeCreatePage({ modal, agent }: { modal: ActionSheetController; agent: AgentCard }) {
  const reason = useOperationGate();
  return <PanePage>
    <WorktreeCreateForm modal={modal} reason={reason} dir={agent.workspaceCwd || agent.cwd} start={fields => createPaneWorktree(agent, fields)} />
  </PanePage>;
}

/** The shared open form as a page of the panel. */
function WorktreeOpenPage({ modal, agent }: { modal: ActionSheetController; agent: AgentCard }) {
  const reason = useOperationGate();
  return <PanePage>
    <WorktreeOpenForm modal={modal} reason={reason} open={target => openPaneWorktree(agent, target)} />
  </PanePage>;
}
