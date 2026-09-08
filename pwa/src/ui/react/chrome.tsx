import { useSyncExternalStore, type ComponentPropsWithRef, type ReactNode } from "react";
import { prefersReducedMotion, showHelp, type HelpBlock } from "../../lib/dom";
import { langPref, setLangPref, t, type LangPref } from "../../lib/i18n";
import type { ListGroup } from "../../lib/ranking";
import { render } from "../../paint";
import { clearNotice, saveListGroup, state, subscribeNotice, visibleNotice, type Notice, type StatusTone } from "../../state";
import type { EmptySpec } from "../chrome";

export function Button({ type = "button", ...props }: ComponentPropsWithRef<"button">) {
  return <button type={type} {...props} />;
}

export function Feedback({ value, id, appNotice = false }: { value: Notice; id?: string; appNotice?: boolean }) {
  return <p id={id} className={`notice notice-${value.tone}`} role={value.tone === "error" ? "alert" : "status"}
    aria-live={value.tone === "error" ? "assertive" : "polite"} aria-atomic="true"
    data-app-notice={appNotice ? "" : undefined} data-react-notice={appNotice ? "" : undefined}>{value.text}</p>;
}

export function useAppNotice() {
  return useSyncExternalStore(subscribeNotice, visibleNotice);
}

export function AppNotice() {
  const notice = useAppNotice();
  return notice ? <Feedback value={notice} appNotice /> : null;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Brand({ tone = null, heading = false }: { tone?: StatusTone | null; heading?: boolean }) {
  return <div className="brand tw:inline-flex tw:items-center tw:gap-[7px] tw:flex-none">
    {heading ? <h1 className="wordmark">pairfob</h1> : <span className="wordmark">pairfob</span>}
    <span className={`brand-dot${tone ? ` dot-${tone}` : ""}`} />
  </div>;
}

export function StatusDot({ tone }: { tone: StatusTone }) {
  return <span className={`dot dot-${tone}`} />;
}

export function StatusLine({ status }: { status: { tone: StatusTone; text: string } }) {
  return <p className="statusline"><StatusDot tone={status.tone} /><span className="statusline-text">{status.text}</span></p>;
}

export function CompletionCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return <Button className="text-link done-count" aria-label={t("home.doneCountAria", { count: String(count) })}
    onClick={() => document.querySelector(".card.status-done")?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center",
    })}>{t("home.doneCount", { count: String(count) })}</Button>;
}

export function SectionTitle({ text, count }: { text: string; count?: number }) {
  return <h2 className="section-title">{text}{count !== undefined && count > 0 && <span className="section-count">{count}</span>}</h2>;
}

export function Chevron({ className = "chev" }: { className?: string }) {
  return <span className={className} aria-hidden="true" />;
}

export function BackButton({ onBack, label }: { onBack: () => void; label?: string }) {
  return <Button className="icon-btn back" onClick={onBack} aria-label={label ?? t("chrome.back")}>‹</Button>;
}

export function BackBar({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return <div className="topbar"><BackButton onBack={onBack} /><h1 className="topbar-title">{title}</h1>{children}</div>;
}

export function GroupToggle({ title, count, expanded, onToggle }: {
  title: string; count: number; expanded: boolean; onToggle: () => void;
}) {
  return <Button className="group-title" aria-expanded={expanded} onClick={onToggle}>
    <Chevron className="group-chev" /><span className="group-name">{title}</span>
    {count > 0 && <span className="section-count">{count}</span>}
  </Button>;
}

const LANG_OPTIONS = [
  { id: "auto", key: "settings.langAuto", compact: "chrome.langAuto" },
  { id: "zh", key: "settings.langZh", compact: "settings.langZh" },
  { id: "en", key: "settings.langEn", compact: "settings.langEn" },
] as const;

function applyLanguage(next: LangPref) {
  if (langPref() === next) return;
  setLangPref(next);
  clearNotice();
  render();
}

export function LanguageControl() {
  return <div className="seg" role="radiogroup" aria-label={t("settings.langAria")}>
    {LANG_OPTIONS.map(option => <Button key={option.id} role="radio" aria-checked={langPref() === option.id}
      className={`seg-item${langPref() === option.id ? " on" : ""}`} onClick={() => applyLanguage(option.id)}>
      {t(option.key)}
    </Button>)}
  </div>;
}

export function LanguageSelect() {
  return <select className="lang-select" aria-label={t("settings.langAria")} value={langPref()}
    onChange={event => applyLanguage(event.currentTarget.value === "en" || event.currentTarget.value === "zh" ? event.currentTarget.value : "auto")}>
    {LANG_OPTIONS.map(option => <option key={option.id} value={option.id}>{t(option.compact)}</option>)}
  </select>;
}

const GROUP_OPTIONS = [
  { id: "flat", key: "list.flat" }, { id: "space", key: "list.space" }, { id: "agent", key: "list.agent" },
] as const;

function applyGroup(id: ListGroup) {
  if (state.listGroup === id) return;
  state.listGroup = id;
  state.listGroupCollapsed = {};
  saveListGroup();
  render();
}

export function ListGroupControl() {
  return <div className="seg" role="radiogroup" aria-label={t("list.groupAria")}>
    {GROUP_OPTIONS.map(option => <Button key={option.id} role="radio" aria-checked={state.listGroup === option.id}
      className={`seg-item${state.listGroup === option.id ? " on" : ""}`} onClick={() => applyGroup(option.id)}>
      {t(option.key)}
    </Button>)}
  </div>;
}

const EMPTY_FIGURE_BLOCKS = { panes: 3, grid: 4, link: 3, device: 2 };

export function EmptyState({ spec }: { spec: EmptySpec }) {
  return <div className="empty">
    {spec.figure && <div className={`empty-figure figure-${spec.figure}`} aria-hidden="true">
      {Array.from({ length: EMPTY_FIGURE_BLOCKS[spec.figure] }, (_, i) => <span key={i} />)}
    </div>}
    <p className="empty-title">{spec.title}</p><p className="empty-sub">{spec.sub}</p>
    {spec.action && <Button className="btn btn-small btn-primary empty-action" disabled={spec.action.disabled === true}
      onClick={spec.action.run}>{spec.action.label}</Button>}
  </div>;
}

export function HerdBanners({ tone }: { tone: StatusTone }) {
  if (tone === "demo") return <p className="banner banner-demo">{t("chrome.demoBanner")}</p>;
  if (tone === "off") return <p className="banner banner-off">{t("chrome.herdrOffBanner")}</p>;
  return null;
}

export function SetRow({ label, value, tone }: { label: string; value: string; tone?: StatusTone }) {
  return <div className="set-row"><span className="set-key">{label}</span>
    <span className="set-val">{tone && <StatusDot tone={tone} />}{value}</span>
  </div>;
}

export function SetNavRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return <Button className="set-row set-nav" aria-label={label} onClick={onClick}>
    <span className="set-key">{label}</span><span className="set-val">{value}<Chevron /></span>
  </Button>;
}

export function HelpButton({ title, blocks }: { title: string; blocks: HelpBlock[] | (() => HelpBlock[]) }) {
  return <Button className="icon-btn set-help" aria-label={t("settings.helpAria", { topic: title })} aria-haspopup="dialog"
    onClick={() => showHelp(title, typeof blocks === "function" ? blocks() : blocks)} />;
}

export function SetHeading({ text, help, children, className = "" }: {
  text: string; help?: HelpBlock[] | (() => HelpBlock[]); children?: ReactNode; className?: string;
}) {
  return <div className={`set-heading tw:flex tw:items-center${className ? ` ${className}` : ""}`}>
    <h2 className="set-title">{text}</h2>{children}{help && <HelpButton title={text} blocks={help} />}
  </div>;
}
