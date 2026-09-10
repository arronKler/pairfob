import { createRef, useLayoutEffect, type FormEventHandler, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

export type ModalController<T> = {
  titleId: string;
  dialog: RefObject<HTMLDialogElement | null>;
  form: RefObject<HTMLFormElement | null>;
  result: Promise<T | null>;
  close(value: T): void;
  dismiss(): void;
  finish(): void;
};

let serial = 0;
const replacements = new Map<string, () => void>();
type ModalOptions<T> = {
  replaceKey?: string;
  cancelValue?: T;
  readClose?: (dialog: HTMLDialogElement) => T | null;
};

/** One React-owned portal per modal; controller callers can keep promise APIs. */
export function presentModal<T>(view: (modal: ModalController<T>) => ReactNode,
  options: ModalOptions<T> & { cancelValue: T }): ModalController<T> & { result: Promise<T> };
export function presentModal<T>(view: (modal: ModalController<T>) => ReactNode, options?: ModalOptions<T>): ModalController<T>;
export function presentModal<T>(view: (modal: ModalController<T>) => ReactNode, options: ModalOptions<T> = {}): ModalController<T> {
  const { replaceKey } = options;
  if (replaceKey) replacements.get(replaceKey)?.();
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const root = createRoot(document.createDocumentFragment());
  let resolve!: (value: T | null) => void;
  let value: T | null = options.cancelValue ?? null;
  let accepted = false;
  let finished = false;
  let restoreFocus = true;
  const modal: ModalController<T> = {
    titleId: `modal-title-${++serial}`,
    dialog: createRef(),
    form: createRef(),
    result: new Promise<T | null>(done => { resolve = done; }),
    close(next) {
      if (finished) return;
      value = next;
      accepted = true;
      if (modal.dialog.current?.open) modal.dialog.current.close("accept");
      else modal.finish();
    },
    dismiss() {
      if (finished) return;
      value = options.cancelValue ?? null;
      accepted = false;
      if (modal.dialog.current?.open) modal.dialog.current.close("cancel");
      else modal.finish();
    },
    finish() {
      if (finished) return;
      finished = true;
      if (!accepted && modal.dialog.current && options.readClose) value = options.readClose(modal.dialog.current);
      flushSync(() => root.unmount());
      queueMicrotask(() => {
        const current = !replaceKey || replacements.get(replaceKey) === replace;
        if (replaceKey && current) replacements.delete(replaceKey);
        if (restoreFocus && current && trigger?.isConnected) trigger.focus({ preventScroll: true });
      });
      resolve(value);
    },
  };
  const replace = () => { restoreFocus = false; modal.dismiss(); };
  if (replaceKey) replacements.set(replaceKey, replace);
  flushSync(() => root.render(createPortal(view(modal), document.body)));
  return modal;
}

export function ModalFrame<T>({ modal, title, className = "modal", heading, children, onSubmit, onInput, describedBy, focus }: {
  modal: ModalController<T>;
  title: string;
  className?: string;
  heading?: ReactNode;
  children: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  onInput?: FormEventHandler<HTMLFormElement>;
  describedBy?: string;
  focus?: (form: HTMLFormElement) => void;
}) {
  useLayoutEffect(() => {
    const dialog = modal.dialog.current!;
    const openedAt = performance.now();
    const cancel = (event: Event) => {
      event.preventDefault();
      if (performance.now() - openedAt >= 400) modal.dismiss();
    };
    const backdrop = (event: MouseEvent) => {
      if (event.target === dialog) cancel(event);
    };
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("click", backdrop);
    dialog.addEventListener("close", modal.finish);
    dialog.showModal();
    focus?.(modal.form.current!);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("click", backdrop);
      dialog.removeEventListener("close", modal.finish);
      if (dialog.open) dialog.close();
    };
  }, [modal]);
  return <dialog ref={modal.dialog} className={className} aria-labelledby={modal.titleId}
    aria-describedby={describedBy} data-react-modal="">
    <form ref={modal.form} method="dialog" onSubmit={onSubmit ?? (event => event.preventDefault())} onInput={onInput}>
      {heading ?? <h2 id={modal.titleId} className="modal-title">{title}</h2>}
      {children}
    </form>
  </dialog>;
}
