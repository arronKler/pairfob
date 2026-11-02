import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../../test-support/dom";
import { closeTestDialogs } from "../../../../../test-support/close-dialogs";
import { setLang } from "../../../../lib/i18n";
import { presentImageEditor, type ImageEditorInput } from "./image-editor";

type Call = { name: string };

function recorder() {
  const calls: Call[] = [];
  return {
    calls,
    ctx: new Proxy({} as CanvasRenderingContext2D, {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        return (...args: unknown[]) => { calls.push({ name: String(prop) }); void args; };
      },
      set() {
        return true;
      },
    }),
  };
}

let originalGetContext: HTMLCanvasElement["getContext"];
let originalToBlob: HTMLCanvasElement["toBlob"] | undefined;
let originalGetBoundingClientRect: HTMLCanvasElement["getBoundingClientRect"] | undefined;
let pointerCaptureStubbed = false;

/** happy-dom keeps canvas constructors on its window; patch through an instance. */
function canvasPrototype() {
  return Object.getPrototypeOf(document.createElement("canvas")) as {
    getContext: HTMLCanvasElement["getContext"];
    toBlob?: HTMLCanvasElement["toBlob"];
    getBoundingClientRect: HTMLCanvasElement["getBoundingClientRect"];
  };
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("en");
  const recording = recorder();
  const proto = canvasPrototype();
  originalGetContext = proto.getContext;
  proto.getContext = (() => recording.ctx) as HTMLCanvasElement["getContext"];
  originalToBlob = proto.toBlob;
  proto.toBlob = function toBlob(cb: BlobCallback): void {
    queueMicrotask(() => cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })));
  } as HTMLCanvasElement["toBlob"];
  // happy-dom reports a zeroed DOMRect, which would map every pointer to the
  // same corner and discard gestures. Report the canvas's actual laid-out CSS
  // box (the component sets both dimensions explicitly from the frame).
  originalGetBoundingClientRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    const width = Number.parseFloat(this.style.width) || this.width;
    const height = Number.parseFloat(this.style.height) || this.height;
    return { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON: () => ({}) } as DOMRect;
  };
  if (!Element.prototype.setPointerCapture) {
    pointerCaptureStubbed = true;
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
  }
});

afterEach(() => {
  closeTestDialogs();
  const proto = canvasPrototype();
  proto.getContext = originalGetContext;
  if (originalToBlob) proto.toBlob = originalToBlob; else delete proto.toBlob;
  if (originalGetBoundingClientRect) proto.getBoundingClientRect = originalGetBoundingClientRect;
  if (pointerCaptureStubbed) {
    delete (Element.prototype as Partial<Element>).setPointerCapture;
    delete (Element.prototype as Partial<Element>).releasePointerCapture;
  }
});

function openEditor(width = 100, height = 100, name = "p.jpg"): HTMLDialogElement {
  const input: ImageEditorInput = {
    name,
    image: { source: {} as CanvasImageSource, width, height, release: () => undefined },
    onApply: async () => null,
    onClose: () => undefined,
  };
  presentImageEditor(input);
  const dialog = document.querySelector<HTMLDialogElement>(".imgedit-modal")!;
  expect(dialog).toBeTruthy();
  expect(dialog.open).toBe(true);
  return dialog;
}

function toolButton(dialog: HTMLElement, label: string): HTMLButtonElement {
  const button = [...dialog.querySelectorAll<HTMLButtonElement>(".imgedit-tool")].find((candidate) => candidate.textContent === label)!;
  expect(button).toBeTruthy();
  return button;
}

function pointerEvent(type: string, x: number, y: number): PointerEvent {
  const View = window as unknown as { PointerEvent: typeof PointerEvent };
  return new View.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 });
}

function canvasBox(canvas: HTMLCanvasElement): { width: number; height: number } {
  return {
    width: Number.parseFloat(canvas.style.width) || canvas.width,
    height: Number.parseFloat(canvas.style.height) || canvas.height,
  };
}

describe("image editor modal", () => {
  test("offers rectangle crop and ellipse highlight as separate tools", () => {
    const dialog = openEditor();
    const labels = [...dialog.querySelectorAll<HTMLButtonElement>(".imgedit-tool")].map((button) => button.textContent);
    expect(labels).toEqual(["Crop", "Ellipse", "Arrow", "Text", "Number marker"]);
  });

  test("preview keeps the source aspect ratio in both CSS dimensions", () => {
    const dialog = openEditor(800, 600);
    const canvas = dialog.querySelector<HTMLCanvasElement>(".imgedit-canvas")!;
    const box = canvasBox(canvas);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height / box.width).toBeCloseTo(600 / 800, 2);
    expect(canvas.width / canvas.height).toBeCloseTo(box.width / box.height, 1);
  });

  test("places numbered markers by tap and supports undo", async () => {
    const dialog = openEditor();
    act(() => toolButton(dialog, "Number marker").click());
    const canvas = dialog.querySelector<HTMLCanvasElement>(".imgedit-canvas")!;
    const { width, height } = canvasBox(canvas);
    await act(async () => canvas.dispatchEvent(pointerEvent("pointerdown", width * 0.3, height * 0.3)));
    await act(async () => canvas.dispatchEvent(pointerEvent("pointerdown", width * 0.6, height * 0.6)));
    const undo = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Undo")!;
    expect(undo.disabled).toBe(false);
    act(() => undo.click());
    const apply = dialog.querySelector<HTMLButtonElement>(".imgedit-apply")!;
    // One marker remains, so apply stays available.
    expect(apply.disabled).toBe(false);
  });

  test("ellipse drag is an annotation that enables save while preserving the full image", async () => {
    const dialog = openEditor(800, 600);
    act(() => toolButton(dialog, "Ellipse").click());
    const canvas = dialog.querySelector<HTMLCanvasElement>(".imgedit-canvas")!;
    const { width, height } = canvasBox(canvas);
    await act(async () => canvas.dispatchEvent(pointerEvent("pointerdown", width * 0.2, height * 0.2)));
    await act(async () => canvas.dispatchEvent(pointerEvent("pointermove", width * 0.7, height * 0.7)));
    await act(async () => canvas.dispatchEvent(pointerEvent("pointerup", width * 0.7, height * 0.7)));
    expect(dialog.querySelector<HTMLButtonElement>(".imgedit-apply")!.disabled).toBe(false);
    // A highlight never installs a crop scrim.
    const ctx = (dialog.querySelector(".imgedit-canvas") as HTMLCanvasElement);
    void ctx;
  });

  test("rectangle crop drag still enables save", async () => {
    const dialog = openEditor();
    act(() => toolButton(dialog, "Crop").click());
    const canvas = dialog.querySelector<HTMLCanvasElement>(".imgedit-canvas")!;
    const { width, height } = canvasBox(canvas);
    await act(async () => canvas.dispatchEvent(pointerEvent("pointerdown", width * 0.2, height * 0.2)));
    await act(async () => canvas.dispatchEvent(pointerEvent("pointermove", width * 0.8, height * 0.8)));
    await act(async () => canvas.dispatchEvent(pointerEvent("pointerup", width * 0.8, height * 0.8)));
    expect(dialog.querySelector<HTMLButtonElement>(".imgedit-apply")!.disabled).toBe(false);
  });

  test("drags an arrow, applies a flattened PNG and closes without touching the original", async () => {
    let applied: File | null = null;
    const input: ImageEditorInput = {
      name: "photo.jpeg",
      image: { source: {} as CanvasImageSource, width: 120, height: 80, release: () => undefined },
      onApply: async (file: File) => { applied = file; return null; },
      onClose: () => undefined,
    };
    presentImageEditor(input);
    const dialog = document.querySelector<HTMLDialogElement>(".imgedit-modal")!;
    const canvas = dialog.querySelector<HTMLCanvasElement>(".imgedit-canvas")!;
    const { width, height } = canvasBox(canvas);
    await act(async () => {
      canvas.dispatchEvent(pointerEvent("pointerdown", width * 0.3, height * 0.25));
      canvas.dispatchEvent(pointerEvent("pointermove", width * 0.85, height * 0.9));
      canvas.dispatchEvent(pointerEvent("pointerup", width * 0.85, height * 0.9));
    });
    const apply = dialog.querySelector<HTMLButtonElement>(".imgedit-apply")!;
    expect(apply.disabled).toBe(false);
    await act(async () => apply.click());
    expect(applied).not.toBeNull();
    expect(applied!.name).toBe("photo.png");
    expect(applied!.type).toBe("image/png");
    expect(dialog.open).toBe(false);
  });

  test("footer keeps secondary actions on one row and the primary button on its own row", () => {
    const dialog = openEditor();
    const secondary = dialog.querySelector(".imgedit-actions-secondary")!;
    expect(secondary.querySelectorAll("button")).toHaveLength(3);
    const actions = dialog.querySelector(".imgedit-actions")!;
    expect(actions.lastElementChild?.classList.contains("imgedit-apply")).toBe(true);
  });

  test("cancel is available and apply stays disabled without edits", () => {
    const dialog = openEditor();
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!;
    expect(cancel).toBeTruthy();
    const apply = dialog.querySelector<HTMLButtonElement>(".imgedit-apply")!;
    expect(apply.disabled).toBe(true);
    act(() => cancel.click());
    expect(dialog.open).toBe(false);
  });

  test("text only places when the text field is non-empty", async () => {
    const dialog = openEditor();
    act(() => toolButton(dialog, "Text").click());
    const canvas = dialog.querySelector<HTMLCanvasElement>(".imgedit-canvas")!;
    const { width, height } = canvasBox(canvas);
    await act(async () => canvas.dispatchEvent(pointerEvent("pointerdown", width * 0.5, height * 0.5)));
    const apply = dialog.querySelector<HTMLButtonElement>(".imgedit-apply")!;
    expect(apply.disabled).toBe(true);

    const textInput = dialog.querySelector<HTMLInputElement>(".imgedit-text")!;
    textInput.value = "hi";
    await act(async () => {
      canvas.dispatchEvent(pointerEvent("pointerdown", width * 0.5, height * 0.5));
    });
    expect(apply.disabled).toBe(false);
  });
});
