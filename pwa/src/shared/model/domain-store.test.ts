import { describe, expect, test } from "bun:test";
import { batch, beginPublicationTransaction, createDomain, detach, endPublicationTransaction,
  flushNotifications, immutableCopy } from "./domain-store";

type Demo = {
  count: number;
  label: string;
  items: { id: string }[];
  nested: { flags: Record<string, boolean> };
};

function demoInitial(): Demo {
  return { count: 0, label: "a", items: [{ id: "x" }], nested: { flags: { open: true } } };
}

function demo() {
  return createDomain<Demo>("demo", demoInitial());
}

function other() {
  return createDomain("other", { value: 0 });
}

describe("domain store snapshots", () => {
  test("a published snapshot is frozen deeply and never changes under a reader", () => {
    const { store, controller } = demo();
    const published = store.get();
    expect(Object.isFrozen(published)).toBeTrue();
    expect(Object.isFrozen(published.items)).toBeTrue();
    expect(Object.isFrozen(published.items[0]!)).toBeTrue();
    expect(Object.isFrozen(published.nested.flags)).toBeTrue();

    controller.write((record) => {
      record.count = 1;
      record.items[0]!.id = "mutated";
      record.nested.flags.open = false;
    });

    expect(published.count).toBe(0);
    expect(published.items[0]!.id).toBe("x");
    expect(published.nested.flags.open).toBeTrue();
    expect(store.get().count).toBe(1);
    expect(store.get().items[0]!.id).toBe("mutated");
    expect(store.get()).not.toBe(published);

    // A reader cannot edit what was published, at the type level or at runtime.
    expect(() => {
      // @ts-expect-error a published snapshot is deeply read-only
      store.get().nested.flags.open = true;
    }).toThrow();
  });

  test("an in-place record mutation cannot leak into an already published snapshot", () => {
    const { store, controller } = demo();
    const published = store.get();
    controller.write((record) => {
      record.items.push({ id: "pushed" });
      record.nested.flags.later = true;
    });
    // The write above published; the older snapshot must still show the old data.
    expect(published.items.length).toBe(1);
    expect("later" in published.nested.flags).toBeFalse();
    expect(store.get().items.length).toBe(2);
    expect(store.get().nested.flags.later).toBeTrue();

    // A mutation that bypasses an action is invisible until the owner
    // publishes; a staged owner write is the real held form of that contract.
    beginPublicationTransaction();
    try {
      controller.stage((record) => { record.items.push({ id: "staged" }); });
      expect(store.get().items.length).toBe(2);
      store.publish();
    } finally {
      endPublicationTransaction();
    }
    expect(store.get().items.length).toBe(3);
  });

  test("foreign values keep their identity and stay usable inside a snapshot", () => {
    const controller = new AbortController();
    const sessions = new Map<string, number>();
    const { store } = createDomain("opaque", { controller, sessions, when: new Date(0) });
    const published = store.get();

    expect(published.controller).toBe(controller);
    expect(published.sessions).toBe(sessions);
    expect(Object.isFrozen(published.controller)).toBeFalse();

    controller.abort();
    published.sessions.set("a", 1);
    expect(published.controller.signal.aborted).toBeTrue();
    expect(store.get().sessions.get("a")).toBe(1);
  });

  test("immutableCopy leaves primitives and class instances alone", () => {
    const error = new Error("boom");
    expect(immutableCopy("text")).toBe("text");
    expect(immutableCopy(7)).toBe(7);
    expect(immutableCopy(error)).toBe(error);
    const copy = immutableCopy({ list: [{ id: 1 }] });
    expect(Object.isFrozen(copy)).toBeTrue();
    expect(Object.isFrozen(copy.list)).toBeTrue();
  });
});

describe("domain store notification", () => {
  test("subscribers hear only their own domain", () => {
    const first = demo();
    const second = other();
    let firstCalls = 0;
    let secondCalls = 0;
    first.store.subscribe(() => { firstCalls += 1; });
    second.store.subscribe(() => { secondCalls += 1; });

    first.controller.write((record) => { record.count += 1; });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);

    second.controller.write((record) => { record.value += 1; });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  test("a staged owner write waits for the commit, reads canonical new, and publishes once", () => {
    const { store, controller } = demo();
    let calls = 0;
    store.subscribe(() => { calls += 1; });

    controller.stage((record) => { record.count = 5; });
    expect(calls).toBe(0);
    expect(store.isDirty()).toBeTrue();
    expect(store.get().count).toBe(0);
    expect(controller.read().count).toBe(5);

    beginPublicationTransaction();
    try {
      store.publish();
    } finally {
      endPublicationTransaction();
    }
    expect(calls).toBe(1);
    expect(store.isDirty()).toBeFalse();
    expect(store.get().count).toBe(5);
  });

  test("a batch publishes every domain but notifies each subscriber once", () => {
    const first = demo();
    const second = other();
    let firstCalls = 0;
    let secondCalls = 0;
    first.store.subscribe(() => { firstCalls += 1; });
    second.store.subscribe(() => { secondCalls += 1; });

    batch(() => {
      first.controller.write((record) => { record.count += 1; });
      first.controller.write((record) => { record.label = "b"; });
      second.controller.write((record) => { record.value += 1; });
      expect(firstCalls).toBe(0);
      expect(secondCalls).toBe(0);
      // Inside the batch both snapshots are already the new ones: a subscriber
      // that does run later sees a coherent pair, never a half-updated pair.
      expect(first.store.get().count).toBe(1);
      expect(second.store.get().value).toBe(1);
    });

    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(first.store.get().label).toBe("b");
  });

  test("flushNotifications outside a batch is a no-op and unsubscribe stops delivery", () => {
    const { store, controller } = demo();
    let calls = 0;
    const release = store.subscribe(() => { calls += 1; });
    flushNotifications();
    expect(calls).toBe(0);
    release();
    controller.write((record) => { record.count += 1; });
    expect(calls).toBe(0);
  });

  test("a snapshot stays referentially stable until something publishes", () => {
    const { store, controller } = demo();
    const published = store.get();
    expect(store.get()).toBe(published);
    controller.stage((record) => { record.count += 1; });
    expect(store.get()).toBe(published);
    beginPublicationTransaction();
    try {
      store.publish();
    } finally {
      endPublicationTransaction();
    }
    expect(store.get()).not.toBe(published);
  });
});

describe("owner authority", () => {
  test("the public store surface carries no writable alias of the record", () => {
    const { store, controller } = demo();
    const surface = store as unknown as Record<string, unknown>;
    for (const leaked of ["current", "peek", "update", "record", "write", "writeIf"]) {
      expect(leaked in surface).toBeFalse();
    }
    expect(Object.keys(surface).sort())
      .toEqual(["get", "isCompositionPending", "isDirty", "name", "publish", "subscribe"]);
    expect(typeof controller.read).toBe("function");
    expect(typeof controller.write).toBe("function");
    expect(typeof controller.writeIf).toBe("function");
  });

  test("a batch updates published snapshots immediately and notifies once", () => {
    const { store, controller } = demo();
    let publishes = 0;
    store.subscribe(() => { publishes += 1; });
    batch(() => {
      controller.write((record) => { record.count = 1; });
      expect(store.get().count).toBe(1);
      controller.write((record) => { record.count = 2; });
      expect(store.get().count).toBe(2);
      expect(publishes).toBe(0);
    });
    expect(publishes).toBe(1);
    expect(store.get().count).toBe(2);
  });

  test("an ordinary write on another domain keeps read-after-write while composition is staged", () => {
    const composition = demo();
    const chat = other();
    let chatNotices = 0;
    chat.store.subscribe(() => { chatNotices += 1; });
    const before = composition.store.get();

    composition.controller.stage((record) => { record.count = 9; });
    chat.controller.write((record) => { record.value = 3; });

    expect(composition.store.get()).toBe(before);
    expect(composition.controller.read().count).toBe(9);
    expect(chat.store.get().value).toBe(3);
    expect(chatNotices).toBe(1);
    beginPublicationTransaction();
    try {
      composition.store.publish();
    } finally {
      endPublicationTransaction();
    }
  });

  test("an ordinary batch merge sees each write while another domain is staged", () => {
    const composition = demo();
    const chat = other();
    let notices = 0;
    const seen: number[] = [];
    chat.store.subscribe(() => {
      notices += 1;
      seen.push(chat.store.get().value);
    });
    const before = composition.store.get();

    composition.controller.stage((record) => { record.count = 9; });
    batch(() => {
      chat.controller.write((record) => { record.value = 3; });
      expect(chat.store.get().value).toBe(3);
      chat.controller.write((record) => { record.value = chat.store.get().value + 1; });
      expect(chat.store.get().value).toBe(4);
      expect(notices).toBe(0);
      expect(composition.store.get()).toBe(before);
    });

    expect(notices).toBe(1);
    expect(seen).toEqual([4]);
    expect(chat.store.get().value).toBe(4);
    expect(composition.store.get()).toBe(before);
    expect(composition.controller.read().count).toBe(9);
    beginPublicationTransaction();
    try {
      composition.store.publish();
    } finally {
      endPublicationTransaction();
    }
  });

  test("a staged composition write holds ordinary write and writeIf until a transaction", () => {
    const { store, controller } = demo();
    let publishes = 0;
    store.subscribe(() => { publishes += 1; });
    const before = store.get();

    controller.stage((record) => { record.count = 4; });
    expect(store.isCompositionPending()).toBeTrue();
    expect(store.get()).toBe(before);
    expect(publishes).toBe(0);

    controller.write((record) => { record.label = "held"; });
    expect(store.get()).toBe(before);
    expect(publishes).toBe(0);
    expect(controller.read().count).toBe(4);
    expect(controller.read().label).toBe("held");

    expect(controller.writeIf((record) => { record.items[0]!.id = "y"; return true; })).toBeTrue();
    expect(store.get()).toBe(before);
    expect(publishes).toBe(0);

    beginPublicationTransaction();
    try {
      store.publish();
    } finally {
      endPublicationTransaction();
    }
    expect(publishes).toBe(1);
    expect(store.isCompositionPending()).toBeFalse();
    expect(store.get().count).toBe(4);
    expect(store.get().label).toBe("held");
    expect(store.get().items[0]!.id).toBe("y");
    expect(before.count).toBe(0);
  });

  test("writeIf publishes only when the owner decided something changed", () => {
    const { store, controller } = demo();
    let publishes = 0;
    const release = store.subscribe(() => { publishes += 1; });
    const before = store.get();

    expect(controller.writeIf((record) => { record.count = 0; return false; })).toBeFalse();
    expect(publishes).toBe(0);
    expect(store.get()).toBe(before);

    expect(controller.writeIf((record) => { record.count = 1; return true; })).toBeTrue();
    expect(publishes).toBe(1);
    expect(store.get().count).toBe(1);
    release();
  });

  test("detach takes ownership of caller data without cloning foreign handles", () => {
    const abort = new AbortController();
    const input = { modes: { p1: "full" as const }, handles: [abort] };
    const owned = detach(input);

    expect(owned).not.toBe(input);
    expect(owned.modes).not.toBe(input.modes);
    expect(owned.handles[0]).toBe(abort);

    input.modes.p1 = "guided";
    input.handles.push(abort);
    expect(owned.modes.p1).toBe("full");
    expect(owned.handles.length).toBe(1);
    expect(Object.isFrozen(owned)).toBeFalse();
  });
});

describe("dictionary keys survive a snapshot copy", () => {
  test("an own __proto__ data key stays data, with a primitive value", () => {
    const modes = JSON.parse('{"__proto__": "full", "p1": "guided"}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(modes, "__proto__")).toBeTrue();
    const { store } = createDomain("dictionary", { modes });

    const published = store.get().modes as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(published, "__proto__")).toBeTrue();
    expect(published.__proto__).toBe("full");
    expect(published.p1).toBe("guided");
    expect(Object.getPrototypeOf(published)).toBe(Object.prototype);
    expect(Object.keys(published).sort()).toEqual(["__proto__", "p1"]);
  });

  test("an own __proto__ data key with an object value does not re-parent the copy", () => {
    const modes = JSON.parse('{"__proto__": {"unexpected": true}, "p1": "guided"}') as Record<string, unknown>;
    const { store } = createDomain("dictionary", { modes });

    const published = store.get().modes as Record<string, unknown> & { unexpected?: boolean };
    expect(Object.getPrototypeOf(published)).toBe(Object.prototype);
    expect(published.unexpected).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(published, "__proto__")).toBeTrue();
    expect(published.__proto__).toEqual({ unexpected: true });
    expect(Object.isFrozen(published.__proto__)).toBeTrue();
  });

  test("an intentional null prototype is preserved", () => {
    const modes: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(modes, "__proto__", { value: "full", enumerable: true, configurable: true, writable: true });
    modes.p1 = "guided";
    const { store } = createDomain("dictionary", { modes });

    const published = store.get().modes as Record<string, unknown>;
    expect(Object.getPrototypeOf(published)).toBeNull();
    expect(published.__proto__).toBe("full");
    expect(published.p1).toBe("guided");
  });

  test("detach keeps the same dictionary semantics for owned input", () => {
    const modes = JSON.parse('{"__proto__": "full"}') as Record<string, unknown>;
    const owned = detach(modes) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(owned, "__proto__")).toBeTrue();
    expect(owned.__proto__).toBe("full");
    expect(Object.getPrototypeOf(owned)).toBe(Object.prototype);
  });
});

describe("declared opaque handles", () => {
  type FixtureSession = { calls: string[]; note(label: string): void; isConnected(): boolean };

  function plainSession(): FixtureSession {
    return {
      calls: [],
      note(label: string): void { this.calls.push(label); },
      isConnected: () => true,
    };
  }

  class ClassSession {
    calls: string[] = [];
    note(label: string): void { this.calls.push(label); }
    isConnected(): boolean { return true; }
  }

  test("a plain-object handle declared opaque keeps identity and its receiver", () => {
    const live = plainSession();
    const { store, controller } = createDomain<FixtureRecord>("session-host", { live: null, cards: [] },
      { opaque: ["live"] });
    controller.write((record) => { record.live = live; });

    const published = store.get();
    expect(published.live).toBe(live);
    expect(Object.isFrozen(published.live)).toBeFalse();
    published.live?.note("through-snapshot");
    expect(live.calls).toEqual(["through-snapshot"]);
    expect(published.live?.isConnected()).toBeTrue();
  });

  test("a class handle keeps working, and undeclared data is still copied", () => {
    const live = new ClassSession();
    const { store, controller } = createDomain<ClassRecord>("mixed", { live: null, cards: [{ paneId: "p1" }] },
      { opaque: ["live"] });
    controller.write((record) => { record.live = live; });

    expect(store.get().live).toBe(live);
    store.get().live?.note("class");
    expect(live.calls).toEqual(["class"]);
    expect(store.get().cards).not.toBe(controller.read().cards);
    expect(Object.isFrozen(store.get().cards[0]!)).toBeTrue();
  });

  test("without the opaque declaration a plain handle would be copied", () => {
    const live = plainSession();
    const { store, controller } = createDomain<FixtureRecord>("undeclared", { live: null, cards: [] });
    controller.write((record) => { record.live = live; });
    expect(store.get().live).not.toBe(live);
    expect(Object.isFrozen(store.get().live)).toBeTrue();
  });
});

type FixtureRecord = { live: { calls: string[]; note(label: string): void; isConnected(): boolean } | null;
  cards: { paneId: string }[] };
type ClassRecord = { live: { calls: string[]; note(label: string): void; isConnected(): boolean } | null;
  cards: { paneId: string }[] };
