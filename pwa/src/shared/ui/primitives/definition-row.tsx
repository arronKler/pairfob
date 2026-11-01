import type { ReactNode } from "react";
import { Button } from "./button";
import { Chevron } from "./navigation";

/**
 * Grouped settings list: a group label, one card of items, an optional note.
 *
 * One alignment grid for every item: text starts on the card's text column,
 * trailing controls end on its trailing edge, and a navigating item always
 * reserves the chevron slot so values end on one line. A card either gives
 * every item a leading icon (`icons`) or none, so text never starts on two
 * columns inside one card. Copy arrives resolved from the owning feature.
 */
export function SetGroup({ label, aside, note, icons = false, className = "", id, children }: {
  label?: ReactNode; aside?: ReactNode; note?: ReactNode; icons?: boolean; className?: string; id?: string; children: ReactNode;
}) {
  return <section className={`set-group${className ? ` ${className}` : ""}`} id={id}>
    {label ? <h2 className="set-group-label"><span>{label}</span>{aside ? <span className="set-group-aside">{aside}</span> : null}</h2> : null}
    <div className={`set-card set-list${icons ? " set-list-icons" : ""}`}>{children}</div>
    {note ? <p className="set-foot">{note}</p> : null}
  </section>;
}

type ItemText = { label: ReactNode; sub?: ReactNode; subTone?: "error" | "warn"; labelId?: string };

function Text({ label, sub, subTone, labelId }: ItemText) {
  return <span className="set-item-text">
    <span className="set-item-label" id={labelId}>{label}</span>
    {sub ? <span className={`set-item-sub${subTone ? ` is-${subTone}` : ""}`}>{sub}</span> : null}
  </span>;
}

/** A static item: text plus an optional trailing control (switch, button, tag, meter). */
export function SetItem({ leading, trailing, className = "", ...text }: ItemText & {
  leading?: ReactNode; trailing?: ReactNode; className?: string;
}) {
  return <div className={`set-item${className ? ` ${className}` : ""}`}>{leading}<Text {...text} />{trailing}</div>;
}

/** An item that navigates: the value sits before the reserved chevron slot. */
export function SetNavItem({ leading, value, valueTone, onClick, ariaLabel, disabled, chevron = true, className = "", ...text }: ItemText & {
  leading?: ReactNode; value?: ReactNode; valueTone?: "accent" | "error" | "warn";
  onClick: () => void; ariaLabel?: string; disabled?: boolean; className?: string;
  /** Rows whose trailing content is itself the destination (a quota meter) drop the chevron. */
  chevron?: boolean;
}) {
  return <Button className={`set-item set-nav${className ? ` ${className}` : ""}`} aria-label={ariaLabel} disabled={disabled} onClick={onClick}>
    {leading}<Text {...text} />
    {value !== undefined && value !== "" ? <span className={`set-val${valueTone ? ` is-${valueTone}` : ""}`}>{value}</span> : null}
    {chevron ? <Chevron className="chev set-chev" /> : null}
  </Button>;
}

/** A compact trailing action inside an item (开启 / 解除 / 导出 / 连接). */
export function SetAction({ tone = "plain", className = "", ...props }: Omit<Parameters<typeof Button>[0], "className"> & {
  tone?: "plain" | "fill" | "danger" | "ok"; className?: string;
}) {
  return <Button {...props} className={`set-action${tone === "plain" ? "" : ` is-${tone}`}${className ? ` ${className}` : ""}`} />;
}

/** A small trailing label ("这台手机", "当前", "已过期"); it never floats mid-row. */
export function SetTag({ tone, children }: { tone?: "ok" | "warn" | "accent"; children: ReactNode }) {
  return <span className={`set-tag${tone ? ` is-${tone}` : ""}`}>{children}</span>;
}

/** An on/off switch for a boolean preference, labelled by its item. */
export function SetSwitch({ checked, labelledBy, onChange, disabled }: {
  checked: boolean; labelledBy: string; onChange: (next: boolean) => void; disabled?: boolean;
}) {
  return <Button className="set-switch" role="switch" aria-checked={checked} aria-labelledby={labelledBy} disabled={disabled}
    onClick={() => onChange(!checked)} />;
}
