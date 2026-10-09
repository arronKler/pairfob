import { useId, useState } from "react";
import { t } from "../../lib/i18n";
import { OPERATION_INPUT_LIMITS } from "../../lib/operations";
import type { SheetOutcome } from "./operation-form-model";
import { PageFooter, refusedField, usePageEnter, useSheetRun } from "./sheet-page";
import { SegmentedControl, SegmentedOption } from "../../shared/ui/primitives";

/**
 * The two Worktree forms, each written once.
 *
 * New Worktree and open Worktree are reached from the session panel (a page
 * pushed into it) and from the branches dialog beside the files (a dialog of
 * its own). Both entries draw these components, so the fields, their order,
 * labels, placeholders, the checks and the primary button are the same
 * whichever one was used; only the frame around them differs. What runs the
 * operation, and why it may not run right now, come from the entry.
 */

const MONO = { className: "create-input is-mono", type: "text", autoComplete: "off", autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

export type WorktreeFields = { branch: string; base: string; label: string; path: string };

type FormFrame = {
  /** The surface the form is in; a finished operation closes it. */
  modal: { dismiss(): void };
  /** Why the operation cannot run right now (offline, another one in flight); empty when it can. */
  reason: string;
};

/**
 * Create runs as the background job card, so nothing else waits for it: the
 * button says it is under way and that the surface can be closed. The form
 * follows the job all the same. When the Worktree exists the surface closes on
 * the session that was opened in it; when the job fails the reason is shown
 * here and the form is the reader's again.
 */
export function WorktreeCreateForm({ modal, reason, dir, start }: FormFrame & {
  /** The repository the Worktree is cut from, named above the button. */
  dir: string;
  /** Start the job and follow it to its end; null when no job could be started. */
  start: (fields: WorktreeFields) => Promise<SheetOutcome> | null;
}) {
  const [fields, setFields] = useState<WorktreeFields>({ branch: "", base: "", label: "", path: "" });
  const run = useSheetRun(modal);
  const set = (key: keyof WorktreeFields) => (event: { currentTarget: HTMLInputElement }) => {
    const value = event.currentTarget.value;
    setFields(current => ({ ...current, [key]: value }));
    run.clearError();
  };
  const submit = () => {
    if (run.pending || reason) return;
    const job = start(fields);
    if (job) void run.submit(() => job);
    else run.refuse(t("op.worktreeJobLimit"));
  };
  const onEnter = usePageEnter(submit);
  return <div ref={run.form} className="create-sheet-body pane-create" onKeyDown={onEnter}>
    <fieldset className="pane-fieldset" disabled={run.pending}>
      <label className="create-field">{t("create.branch")}
        <input {...MONO} name="branch" value={fields.branch} placeholder={t("create.branchHint")} maxLength={OPERATION_INPUT_LIMITS.branch}
          data-desk-autofocus="" onChange={set("branch")} />
      </label>
      <label className="create-field">{t("create.base")}
        <input {...MONO} name="base" value={fields.base} placeholder={t("create.baseHint")} maxLength={OPERATION_INPUT_LIMITS.base} onChange={set("base")} />
      </label>
      <label className="create-field">
        <span>{t("pm.wtName")} <span className="create-optional">{t("create.optional")}</span></span>
        <input className="create-input" type="text" name="label" autoComplete="off" value={fields.label} placeholder={t("pm.wtNameHint")}
          maxLength={OPERATION_INPUT_LIMITS.label} onChange={set("label")} />
      </label>
      <details className="pane-precise">
        <summary>{t("pm.wtAdvanced")}</summary>
        <input {...MONO} name="path" value={fields.path} placeholder={t("create.pathPlaceholder")} aria-label={t("pm.wtAdvanced")}
          maxLength={OPERATION_INPUT_LIMITS.path} onChange={set("path")} />
      </details>
      <p className="create-hint">{t("pm.wtCreateHint")}</p>
    </fieldset>
    <PageFooter summary={dir ? t("pm.wtCreateSummary", { dir }) : undefined} label={t("pm.wtCreate")} busyLabel={t("pm.wtCreateStarted")}
      run={run} reason={reason} background onSubmit={submit} />
  </div>;
}

/** One target, named one way: a branch or a path, never both. */
export function WorktreeOpenForm({ modal, reason, open }: FormFrame & {
  open: (target: { path: string } | { branch: string }) => Promise<SheetOutcome>;
}) {
  const [by, setBy] = useState<"branch" | "path">("branch");
  const [value, setValue] = useState("");
  const run = useSheetRun(modal);
  const noteId = useId();
  const submit = () => {
    if (run.pending || reason) return;
    const target = value.trim();
    if (!target) run.refuse(t("form.needPathOrBranch"), "target");
    else void run.submit(() => open(by === "path" ? { path: target } : { branch: target }));
  };
  const onEnter = usePageEnter(submit);
  return <div ref={run.form} className="create-sheet-body pane-create" onKeyDown={onEnter}>
    <fieldset className="pane-fieldset" disabled={run.pending}>
      <SegmentedControl className="create-seg" aria-label={t("menu.openWorktree")}>
        {(["branch", "path"] as const).map(option => <SegmentedOption key={option} selected={by === option}
          onClick={() => { setBy(option); run.clearError(); }}>{t(option === "branch" ? "pm.wtByBranch" : "pm.wtByPath")}</SegmentedOption>)}
      </SegmentedControl>
      <input {...MONO} name="target" value={value} aria-label={t(by === "branch" ? "pm.wtByBranch" : "pm.wtByPath")} data-autofocus=""
        placeholder={by === "branch" ? t("pm.wtBranchPlaceholder") : t("create.pathPlaceholder")}
        maxLength={by === "branch" ? OPERATION_INPUT_LIMITS.branch : OPERATION_INPUT_LIMITS.path}
        {...refusedField(run, "target", noteId)}
        onChange={(event) => { setValue(event.currentTarget.value); run.clearError(); }} />
      <p className="create-hint">{t("pm.wtOpenHint")}</p>
    </fieldset>
    <PageFooter label={t("pm.wtOpen")} busyLabel={t("pm.opening")} run={run} reason={reason} noteId={noteId} onSubmit={submit} />
  </div>;
}
