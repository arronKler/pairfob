import { ChevronRight, CircleAlert, Folder, Plus, RefreshCw, SlidersHorizontal, Terminal } from "lucide-react";
import { useState } from "react";
import { t } from "../../../lib/i18n";
import { Button } from "../../../shared/ui/primitives";
import type { HerdActions } from "../actions";
import type { HerdEmptyAction, HerdEmptyView } from "../model/herd-view";
import { HerdSkeleton } from "./herd-skeleton";

/**
 * Why the list is empty, said once and anchored under the header.
 *
 * Nothing open: a left-aligned invitation with one primary action and the
 * directories this phone used before. Herdr gone or silent: a solid panel with
 * what to run on the computer. Offline or reconnecting: the header already
 * says so, so the list only notes what happens next above still placeholder rows.
 *
 * `beside` is the desk rail. The column next to it says all of this, with the
 * command and the buttons (`app/layout/desk-empty.tsx`), so the rail notes only
 * the fact, in the place the rows would start, and keeps what is the list's
 * own: the directories used before.
 */
export function HerdEmpty({ empty, actions, beside = false }: { empty: HerdEmptyView; actions: HerdActions; beside?: boolean }) {
  if (empty.kind === "offline" || empty.kind === "reconnecting") {
    return (
      <>
        {/* Beside the rail the main column carries this line; the still rows alone stand for the list. */}
        {beside ? null : <p className="herd-empty-note" role="status">{empty.sub}</p>}
        <HerdSkeleton still />
      </>
    );
  }
  if (beside) {
    const nothingYet = empty.kind === "none" || empty.kind === "noCreate";
    return (
      <section className="herd-empty is-beside" aria-labelledby="herd-empty-title">
        <h2 id="herd-empty-title" className="herd-empty-note">{nothingYet ? t("empty.noneTitle") : empty.title}</h2>
        <RecentDirs empty={empty} actions={actions} />
      </section>
    );
  }
  if (empty.kind === "exited" || empty.kind === "unverifiable") {
    const Icon = empty.kind === "exited" ? Terminal : CircleAlert;
    return (
      <section className={`herd-empty-panel is-${empty.kind}`} aria-labelledby="herd-empty-title">
        <h2 id="herd-empty-title" className="herd-empty-panel-title"><Icon size={20} aria-hidden="true" />{empty.title}</h2>
        <p className="herd-empty-sub">{empty.sub}</p>
        {empty.command ? <CommandLine command={empty.command} /> : null}
        <EmptyActions empty={empty} actions={actions} />
      </section>
    );
  }
  return (
    <section className="herd-empty" aria-labelledby="herd-empty-title">
      <span className="herd-empty-glyph" aria-hidden="true"><span /><span /><i /></span>
      <h2 id="herd-empty-title" className="herd-empty-title">{empty.title}</h2>
      <p className="herd-empty-sub">{empty.sub}</p>
      {empty.command ? <CommandLine command={empty.command} label={t("empty.runOnComputer")} /> : null}
      <EmptyActions empty={empty} actions={actions} />
      <RecentDirs empty={empty} actions={actions} />
    </section>
  );
}

function RecentDirs({ empty, actions }: { empty: HerdEmptyView; actions: HerdActions }) {
  if (!empty.recentDirs.length) return null;
  return (
    <div className="herd-empty-recent">
      <h3 className="herd-empty-recent-label">{t("empty.recentDirs")}</h3>
      <div className="herd-group-body">
        {empty.recentDirs.map((dir) => (
          <Button key={dir} className="card-main herd-empty-dir" onClick={() => actions.createInDir(dir)}>
            <span className="herd-empty-dir-icon" aria-hidden="true"><Folder size={18} /></span>
            <span className="herd-empty-dir-path">{dir}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        ))}
      </div>
    </div>
  );
}

const ACTION_ICON: Record<HerdEmptyAction, typeof Plus> = { create: Plus, retry: RefreshCw, details: SlidersHorizontal };

function EmptyActions({ empty, actions }: { empty: HerdEmptyView; actions: HerdActions }) {
  if (!empty.actions.length) return null;
  return (
    <div className="herd-empty-actions">
      {empty.actions.map((action) => {
        const Icon = ACTION_ICON[action.kind];
        return (
          <Button key={action.kind} className={`btn${action.primary ? " btn-primary" : ""} herd-empty-action`}
            disabled={action.disabled} onClick={() => actions.runEmptyAction(action.kind)}>
            <Icon size={18} aria-hidden="true" />{action.label}
          </Button>
        );
      })}
    </div>
  );
}

/** A command to run on the computer; the copy result replaces the button label for a moment. */
export function CommandLine({ command, label }: { command: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () => {
    // Called inside the tap: some browsers only allow clipboard writes there.
    const write = navigator.clipboard?.writeText(command) ?? Promise.reject(new Error("no clipboard"));
    void write.then(() => setState("copied"), () => setState("failed"));
    window.setTimeout(() => setState("idle"), 1600);
  };
  return (
    <div className="herd-empty-command">
      {label ? <span className="herd-empty-command-label">{label}</span> : null}
      <code>{command}</code>
      <Button className="text-link herd-empty-copy" onClick={copy} aria-label={t("empty.copyAria", { command })}>
        {state === "copied" ? t("empty.copied") : state === "failed" ? t("empty.copyFailed") : t("empty.copy")}
      </Button>
    </div>
  );
}
