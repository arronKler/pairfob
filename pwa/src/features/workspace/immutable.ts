/** Clone/freeze nested workspace values so snapshots never alias the live model. */

function copyOwn<T>(value: T, freeze: boolean): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => copyOwn(item, freeze));
    return (freeze ? Object.freeze(items) : items) as T;
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value as object)) {
    Object.defineProperty(copy, key, {
      value: copyOwn((value as Record<string, unknown>)[key], freeze),
      enumerable: true,
      writable: !freeze,
      configurable: !freeze,
    });
  }
  return (freeze ? Object.freeze(copy) : copy) as T;
}

export function cloneData<T>(value: T): T {
  return copyOwn(value, false);
}

export function freezeData<T>(value: T): T {
  return copyOwn(value, true);
}

type NestedSlot<T> = { source: T; frozen: T; compat: T };

export function nestedSlot<T>(previous: NestedSlot<T> | undefined, source: T): NestedSlot<T> {
  if (previous && Object.is(previous.source, source)) return previous;
  const frozen = freezeData(cloneData(source));
  return { source, frozen, compat: cloneData(frozen) };
}
