import { t } from "../../lib/i18n";

const FILE_SKELETON_LINES = 48;
const LIST_SKELETON_ROWS = 10;
const CHANGE_SKELETON_ROWS = 6;
const DIFF_SKELETON_LINES = 28;
const DIFF_SKELETON_KINDS = ["meta", "meta", "hunk", "delete", "delete", "add", "add", "context", "context", "hunk", "delete", "add", "context", "context"] as const;

const skeletonSlots = new Set<string>();

export function markPendingSlot(slot: string): void {
  skeletonSlots.add(slot);
}

export function consumeReveal(slot: string): boolean {
  return skeletonSlots.delete(slot);
}

function markPending(label: string) {
  return { role: "status" as const, "aria-live": "polite" as const, "aria-busy": true, "aria-label": label };
}

export function FilePending() {
  markPendingSlot("file");
  return <div className="workspace-file-pending" {...markPending(t("workspace.readingFile"))}>
    <div className="workspace-file-skeleton" aria-hidden="true">
      {Array.from({ length: FILE_SKELETON_LINES }, (_, i) => <div key={i} className="workspace-file-skeleton-line" />)}
    </div>
  </div>;
}

export function ListPending() {
  markPendingSlot("nav");
  return <section className="workspace-panel workspace-list-pending" {...markPending(t("workspace.loading"))}>
    <div className="workspace-list-skeleton" aria-hidden="true">
      {Array.from({ length: LIST_SKELETON_ROWS }, (_, i) => (
        <div key={i} className="workspace-list-skeleton-row">
          <span className="workspace-list-skeleton-icon" />
          <span className="workspace-list-skeleton-body">
            <span className="workspace-list-skeleton-name" />
            <span className="workspace-list-skeleton-meta" />
          </span>
        </div>
      ))}
    </div>
  </section>;
}

export function ChangePending() {
  markPendingSlot("nav");
  return <section className="workspace-panel workspace-change-pending" {...markPending(t("workspace.loading"))}>
    <div className="workspace-change-skeleton" aria-hidden="true">
      <div className="workspace-change-skeleton-title" />
      {Array.from({ length: CHANGE_SKELETON_ROWS }, (_, i) => (
        <div key={i} className="workspace-change-skeleton-row">
          <span className="workspace-change-skeleton-body">
            <span className="workspace-list-skeleton-name" />
            <span className="workspace-list-skeleton-meta" />
          </span>
          <span className="workspace-change-skeleton-mark" />
        </div>
      ))}
    </div>
  </section>;
}

export function DiffPending() {
  markPendingSlot("diff");
  return <div className="workspace-diff-pending" {...markPending(t("workspace.readingDiff"))}>
    <div className="workspace-diff-skeleton" aria-hidden="true">
      {Array.from({ length: DIFF_SKELETON_LINES }, (_, i) => {
        const kind = DIFF_SKELETON_KINDS[i % DIFF_SKELETON_KINDS.length];
        return <div key={i} className={`workspace-diff-skeleton-line diff-${kind}`}>
          <span className="workspace-diff-skeleton-gutter" />
          <span className="workspace-diff-skeleton-gutter" />
          <span className="workspace-diff-skeleton-text" />
        </div>;
      })}
    </div>
  </div>;
}

export function ReservedStat({ className, text }: { className: string; text: string | null }) {
  return <span className={`${className}${text ? "" : " is-pending"}`} aria-hidden={text ? undefined : "true"}>{text ?? ""}</span>;
}
