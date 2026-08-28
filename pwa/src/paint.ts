let paintImpl = (): void => {};

export function setRenderer(fn: () => void): void {
  paintImpl = fn;
}

export function render(): void {
  paintImpl();
}
