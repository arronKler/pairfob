import { SegmentedOption } from "../primitives/segmented-control";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DESK_FORM } from "./desk-form";
import { useDialogLifecycle } from "./dialog-lifecycle";
import { createEscapeSteps, EscapeStepsContext } from "./escape-steps";
import { SheetContent } from "./sheet-content";
import { presentModal, type ModalController } from "./modal";
import { overlayOrigin } from "./origin";
import { deskInput, popoverTarget, type PopoverKind, type PopoverTarget } from "./popover";
import { PopoverKindContext, useMenuItemRole, usePopover, usePopoverPresentation } from "./popover-frame";
import { SheetNavContext, type SheetNav, type SheetPage } from "./sheet-stack";

export type SheetAction = () => void | Promise<void>;
export type ActionSheetController = ModalController<SheetAction>;
export type ActionSheetOptions = {
  /** A second heading line naming what the sheet acts on. */
  subtitle?: string;
  /** Opens at a shorter height and grows on a pull or a tap on the handle. */
  expandable?: boolean;
  className?: string;
  /**
   * Opened with a mouse or the keyboard on a desk layout, present anchored to
   * what opened it instead of as a sheet: `menu` for a flat list of commands,
   * `panel` for a sheet that keeps its settings and pages. Touch and phone
   * layouts always get the sheet, so this is safe to set unconditionally.
   */
  popover?: PopoverKind;
  /** The trigger, when it is not the control the opening gesture landed on. */
  anchor?: Element | null;
  /**
   * Where focus goes on close when the trigger cannot take it back: the list a
   * row's menu was opened in, for a row that left it meanwhile. Asked only for
   * a mouse or the keyboard; a finger left no keyboard position to give back.
   */
  home?: () => HTMLElement | null;
};

const PAGE_FOCUS = "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)";
/**
 * Where a surface starts the reader. `data-autofocus` names the control at any
 * width; `data-desk-autofocus` names one for a mouse or the keyboard only, where
 * focusing a field raises no on-screen keyboard and a ring has to sit well.
 */
const START = ".sheet-body [data-autofocus]:not(:disabled)";
const DESK_START = ".sheet-body [data-desk-autofocus]:not(:disabled)";
const PAGE_START = ".sheet-page [data-desk-autofocus]:not(:disabled), .sheet-page [data-autofocus]:not(:disabled)";

/**
 * Where a pushed page starts a finger. Its first control, unless that is a
 * field the page did not name with `data-autofocus`: focus there raises the
 * on-screen keyboard over a form the reader has not read yet, so the page's
 * first button takes it, as it does when the same form is a sheet of its own.
 */
function touchPageStart(body: HTMLElement): HTMLElement | null {
  const first = body.querySelector<HTMLElement>(`.sheet-page ${PAGE_FOCUS}`);
  if (!first?.matches("input, textarea") || first.matches("[data-autofocus]")) return first;
  return body.querySelector<HTMLElement>(".sheet-page button:not(:disabled)") ?? first;
}

/** What makes a control that one among its page's: its kind, its classes and its name. */
function signature(control: Element): string {
  return `${control.tagName}|${control.className}|${control.getAttribute("aria-label") ?? control.textContent ?? ""}`;
}

export function SheetFrame<T>({ modal, title, children, className = "", subtitle, expandable = false, popover = null }: {
  modal: ModalController<T>; title: string; children: ReactNode; className?: string; subtitle?: string; expandable?: boolean;
  /**
   * Anchored presentation, decided when the sheet opens. Whether it stays
   * anchored follows the window (`usePopoverPresentation`).
   */
  popover?: PopoverTarget | null;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<SheetPage[]>([]);
  const [motion, setMotion] = useState<"" | "push" | "pop">("");
  const [expanded, setExpanded] = useState(false);
  const depth = useRef(0);
  depth.current = pages.length;
  // The control each pushed page was opened from. The page it returns to is
  // drawn anew, so the node itself is gone: it is known again by what it is,
  // or, when its text has changed meanwhile (a row shows a value), by its place.
  const openers = useRef<Array<{ name: string; at: number } | null>>([]);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const nav = useMemo<SheetNav>(() => ({
    push(page) {
      // A pressed button does not take focus in every engine, so the gesture
      // says which it was; a caller that pushes on its own leaves what holds focus.
      const pressed = overlayOrigin()?.target?.closest("button") ?? null;
      const held = document.activeElement;
      const from = pressed && body.current?.contains(pressed) ? pressed : held && body.current?.contains(held) ? held : null;
      openers.current[depth.current] = from
        ? { name: signature(from), at: [...body.current?.querySelectorAll(PAGE_FOCUS) ?? []].indexOf(from) } : null;
      setMotion("push");
      setPages(stack => [...stack, page]);
    },
    pop() { setMotion("pop"); setPages(stack => stack.slice(0, -1)); },
    depth: pages.length + 1,
  }), [pages.length]);
  const anchor = usePopoverPresentation(modal.dialog, popover);
  const deskRef = useRef(false);
  const [steps] = useState(createEscapeSteps);
  // Escape undoes the last step first: what a page asked in place (`steps`),
  // then the page itself, then the sheet.
  const deskForm = useDialogLifecycle({ dialog: modal.dialog, onDismiss: modal.dismiss, onClose: modal.finish, steps,
    onCancel: () => { if (depth.current) nav.pop(); else modal.dismiss(); },
    // The gesture is bound for a popover too: it asks on every touch whether
    // the dialog is a sheet, and a popover becomes one below the desk tier.
    cancelGuardMs: 0, sheet: { form: modal.form, scroller: body },
    detents: expandable ? { expanded: () => expandedRef.current, set: setExpanded } : undefined,
    // A sheet may name its starting control; otherwise the first enabled button.
    focus: () => ((deskRef.current ? modal.form.current?.querySelector<HTMLElement>(DESK_START) : null)
      ?? modal.form.current?.querySelector<HTMLElement>(START)
      ?? modal.form.current?.querySelector<HTMLButtonElement>(".sheet-body button:not(:disabled)"))?.focus() });
  deskRef.current = deskForm;
  usePopover(modal.dialog, anchor, modal.dismiss);
  // A new page starts at its top and takes focus, so keyboard and screen-reader
  // users land in the page they asked for rather than on a removed control. A
  // page stepped back from gives focus to the control that opened it.
  useLayoutEffect(() => {
    if (!motion || !body.current) return;
    body.current.scrollTop = 0;
    const from = motion === "pop" ? openers.current[pages.length] : null;
    const controls = from ? [...body.current.querySelectorAll<HTMLElement>(PAGE_FOCUS)] : [];
    const opener = from ? controls.find(control => signature(control) === from.name) ?? controls[from.at] : undefined;
    const named = motion === "push" && deskRef.current ? body.current.querySelector<HTMLElement>(PAGE_START) : null;
    const start = motion === "push" && !deskRef.current ? touchPageStart(body.current) : body.current.querySelector<HTMLElement>(`.sheet-page ${PAGE_FOCUS}`);
    (opener ?? named ?? start)?.focus({ preventScroll: true });
  }, [pages.length, motion]);
  const top = pages.at(-1);
  // The root keeps its plain DOM until the reader first navigates, so sheets
  // that never push are laid out exactly as before.
  const page = top || motion
    ? <div key={top ? `${pages.length}:${top.key}` : "root"} className={`sheet-page is-${motion}`}>{top ? top.render() : children}</div>
    : children;
  // Anchored or centred, never both: a sheet with nothing left to anchor to is the desk card.
  const classes = ["modal", "sheet", anchor ? `popover popover-${anchor.kind}` : deskForm && DESK_FORM,
    expandable && "is-expandable", expanded && "is-expanded", className].filter(Boolean).join(" ");
  // A pushed page is a form or a detail view, not the command list, so menu semantics stop at the root.
  const kind = anchor && !top ? anchor.kind : null;
  return <dialog ref={modal.dialog} className={classes} aria-labelledby={modal.titleId} data-react-modal="" data-react-action-sheet=""
    data-popover={anchor?.kind}>
    <form ref={modal.form} method="dialog" onSubmit={event => event.preventDefault()}>
      <EscapeStepsContext value={steps}>
        <SheetNavContext value={nav}>
          <PopoverKindContext value={kind}>
            <SheetContent title={top?.title ?? title} subtitle={top ? undefined : subtitle} titleId={modal.titleId}
              onDismiss={modal.dismiss} onBack={top ? nav.pop : undefined} backLabel={top ? pages.at(-2)?.title ?? title : undefined} bodyRef={body}
              expand={expandable && !anchor ? { expanded, toggle: () => setExpanded(value => !value) } : undefined}
              bodyRole={kind === "menu" ? "menu" : undefined} desk={deskForm && anchor?.kind !== "menu"}>
              {page}
            </SheetContent>
          </PopoverKindContext>
        </SheetNavContext>
      </EscapeStepsContext>
    </form>
  </dialog>;
}

/** Follow-up dialogs open on the next task, after native close and React teardown. */
export function showActionSheet(title: string, content: (modal: ActionSheetController) => ReactNode,
  options: ActionSheetOptions = {}): void {
  for (const stale of document.querySelectorAll<HTMLDialogElement>("dialog.sheet[open]:not([data-react-action-sheet])")) stale.close();
  const popover = popoverTarget(options.popover, options.anchor);
  const modal = presentModal<SheetAction>(controller => <SheetFrame modal={controller} title={title} subtitle={options.subtitle}
    expandable={options.expandable} className={options.className} popover={popover}>
    {content(controller)}
  </SheetFrame>, { replaceKey: "action-sheet",
    // A clicked button does not take focus in every engine; the anchor is where focus belongs afterwards.
    returnFocus: popover?.anchor instanceof HTMLElement ? popover.anchor : undefined,
    focusHome: deskInput() ? options.home : undefined });
  void modal.result.then(action => { if (action) window.setTimeout(() => void action(), 0); });
}

export function MenuItem({ modal, children, action, danger = false, disabled = false }: {
  modal: ActionSheetController; children: ReactNode; action?: SheetAction; danger?: boolean; disabled?: boolean;
}) {
  return <button type="button" className={`menu-item${danger ? " menu-danger" : ""}`} role={useMenuItemRole()} disabled={disabled}
    onClick={() => action ? modal.close(action) : modal.dismiss()}>{children}</button>;
}

/** A titled run of rows; inside a popover menu the title names a group of commands. */
export function MenuSection({ title, children }: { title: string; children: ReactNode }) {
  if (!useMenuItemRole()) return <><h3 className="menu-section-title">{title}</h3>{children}</>;
  return <div className="menu-section" role="group" aria-label={title}>
    <h3 className="menu-section-title" aria-hidden="true">{title}</h3>{children}
  </div>;
}

/**
 * A segmented choice. By default picking closes the sheet and runs the action
 * afterwards (the choice changes the screen). `stay` applies it in place for
 * adjustments the reader watches take effect behind the sheet. `start` makes
 * the chosen option where a mouse or the keyboard starts in the surface.
 */
export function MenuRadio({ modal, label, aria, selected, action, disabled = false, stay = false, start = false }: {
  modal: ActionSheetController; label: string; aria: string; selected: boolean; action: SheetAction; disabled?: boolean; stay?: boolean;
  start?: boolean;
}) {
  return <SegmentedOption selected={selected} aria-label={aria} disabled={disabled} data-desk-autofocus={start && selected ? "" : undefined}
    onClick={() => {
      if (selected) return;
      if (stay) void action();
      else modal.close(action);
    }}>{label}</SegmentedOption>;
}
