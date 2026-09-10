import { resetBoardTestDOM } from "../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, Fragment, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { listGroup, preferencesStore, setListGroup } from "../features/settings/preferences-store";
import { createDomain, type DomainStore } from "../shared/model/domain-store";
import { createDomainUpdates, useDomainUpdates, type DomainUpdates, type DomainWatch } from "./domain-updates";

type Fake = { store: DomainStore<object>; publish(value: number): void; subscribers(): number };

function fake(name: string, initial = 0): Fake {
  const listeners = new Set<() => void>();
  let snapshot = { value: initial };
  const store = {
    name,
    get: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: () => {},
    markDirty: () => {},
    isDirty: () => false,
    reset: () => {},
  } as unknown as DomainStore<object>;
  return {
    store,
    publish(value: number) {
      snapshot = { value };
      for (const listener of [...listeners]) listener();
    },
    subscribers: () => listeners.size,
  };
}

describe("page domain subscriptions", () => {
  test("a publish of a watched domain bumps the revision and notifies once", () => {
    const board = fake("board");
    const updates = createDomainUpdates([{ store: board.store }]);
    let notified = 0;
    const release = updates.subscribe(() => {
      notified += 1;
    });
    expect(updates.read()).toBe(0);
    board.publish(1);
    expect(notified).toBe(1);
    expect(updates.read()).toBe(1);
    board.publish(2);
    expect(notified).toBe(2);
    expect(updates.read()).toBe(2);
    release();
  });

  test("a keyed watch keeps the snapshot stable for publishes it does not render", () => {
    const board = fake("board");
    const watches: DomainWatch[] = [{ store: board.store, keyOf: (snapshot) => (snapshot as { value: number }).value % 2 }];
    const updates = createDomainUpdates(watches);
    let notified = 0;
    updates.subscribe(() => {
      notified += 1;
    });
    const seen = updates.read();
    // 0 -> 2 keeps the key at 0: a camera-style publish the page does not render.
    board.publish(2);
    expect(notified).toBe(0);
    expect(updates.read()).toBe(seen);
    board.publish(3);
    expect(notified).toBe(1);
    expect(updates.read()).toBe(seen + 1);
    board.publish(5);
    expect(notified).toBe(1);
    expect(updates.read()).toBe(seen + 1);
  });

  test("the first publish after a mount is judged against the mounted key", () => {
    const board = fake("board", 4);
    const updates = createDomainUpdates([
      { store: board.store, keyOf: (snapshot) => (snapshot as { value: number }).value },
    ]);
    let notified = 0;
    updates.subscribe(() => {
      notified += 1;
    });
    board.publish(4);
    expect(notified).toBe(0);
    board.publish(5);
    expect(notified).toBe(1);
  });

  test("an unkeyed watch treats every published snapshot as a new value", () => {
    const board = fake("board", 4);
    const updates = createDomainUpdates([{ store: board.store }]);
    const seen = updates.read();
    board.publish(4);
    expect(updates.read()).toBe(seen + 1);
    // Reading again without a publish is pure: the token does not move.
    expect(updates.read()).toBe(seen + 1);
    expect(updates.read()).toBe(seen + 1);
  });

  test("a publish nobody was listening to is still in the snapshot", () => {
    const board = fake("board");
    const updates = createDomainUpdates([{ store: board.store }]);
    expect(updates.read()).toBe(0);
    // The install gap: the domain moved before any subscriber existed.
    board.publish(1);
    let notified = 0;
    updates.subscribe(() => {
      notified += 1;
    });
    expect(updates.read()).toBe(1);
    board.publish(2);
    expect(notified).toBe(1);
    expect(updates.read()).toBe(2);
  });

  test("store subscriptions are shared by listeners and released with the last one", () => {
    const board = fake("board");
    const dashboard = fake("dashboard");
    const updates = createDomainUpdates([{ store: board.store }, { store: dashboard.store }]);
    expect(board.subscribers()).toBe(0);
    const first = updates.subscribe(() => {});
    const second = updates.subscribe(() => {});
    expect(board.subscribers()).toBe(1);
    expect(dashboard.subscribers()).toBe(1);
    first();
    expect(board.subscribers()).toBe(1);
    second();
    expect(board.subscribers()).toBe(0);
    expect(dashboard.subscribers()).toBe(0);
    // A later mount subscribes again, and a publish after it is heard.
    const third = updates.subscribe(() => {});
    expect(board.subscribers()).toBe(1);
    const seen = updates.read();
    board.publish(9);
    expect(updates.read()).toBe(seen + 1);
    third();
  });

  test("an unmounted page hears nothing", () => {
    const board = fake("board");
    const updates = createDomainUpdates([{ store: board.store }]);
    let notified = 0;
    const release = updates.subscribe(() => {
      notified += 1;
    });
    release();
    board.publish(1);
    expect(notified).toBe(0);
  });

  test("an earlier domain reader cannot swallow a mounted listener's notification", () => {
    const board = fake("board");
    const updates = createDomainUpdates([{ store: board.store }]);
    board.store.subscribe(() => {
      updates.read();
    });
    let notified = 0;
    updates.subscribe(() => {
      notified += 1;
    });
    expect(updates.read()).toBe(0);
    board.publish(1);
    expect(notified).toBe(1);
    expect(updates.read()).toBe(1);
  });
});


/**
 * The real-React window: a page renders from a domain, and something else writes
 * that domain in a layout effect — after the page rendered, before its passive
 * subscription exists. React re-reads the snapshot after subscribing, so a derived
 * snapshot catches the write; a notification counter cannot.
 */
function Page({ updates }: { updates: DomainUpdates }) {
  useDomainUpdates(updates);
  return <output className="group">{listGroup()}</output>;
}

function WriterOnMount({ group }: { group: "space" | "agent" }) {
  useLayoutEffect(() => {
    setListGroup(group);
  }, [group]);
  return null;
}

describe("page subscription window", () => {
  let root: Root | null = null;
  let host: HTMLElement;

  beforeEach(async () => {
    await resetBoardTestDOM();
    setListGroup("flat");
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
    setListGroup("flat");
  });

  test("a domain write in the subscribe window is not lost", () => {
    const updates = createDomainUpdates([{ store: preferencesStore as unknown as DomainStore<object> }]);
    act(() => {
      root = createRoot(host);
      root.render(
        <>
          <Page updates={updates} />
          <WriterOnMount group="space" />
        </>,
      );
    });
    // The store moved during the mount; the page must show it, not what it first read.
    expect(listGroup()).toBe("space");
    expect(host.querySelector(".group")?.textContent).toBe("space");
  });

  test("direct store control and the page adapter both catch a layout-effect write", () => {
    for (const direct of [true, false]) {
      const domain = createDomain("subscription-window", { value: "before" });
      const updates = createDomainUpdates([{ store: domain.store as unknown as DomainStore<object> }]);
      function Value() {
        if (direct) useSyncExternalStore(domain.store.subscribe, domain.store.get);
        else useDomainUpdates(updates);
        return createElement("span", { className: direct ? "direct" : "page" }, domain.store.get().value);
      }
      function InterleavedWriter() {
        useLayoutEffect(() => {
          domain.controller.write((record) => {
            record.value = "after";
          });
        }, []);
        return null;
      }
      act(() => {
        root = createRoot(host);
        root.render(createElement(Fragment, null, createElement(Value), createElement(InterleavedWriter)));
      });
      expect({ published: domain.store.get().value, rendered: host.textContent }).toEqual({
        published: "after",
        rendered: "after",
      });
      act(() => root?.unmount());
      root = null;
    }
  });

  test("an earlier domain subscriber reading the snapshot cannot swallow the mounted page notification", () => {
    const domain = createDomain("read-before-notify", { value: "before" });
    const updates = createDomainUpdates([{ store: domain.store as unknown as DomainStore<object> }]);
    const stop = domain.store.subscribe(() => {
      updates.read();
    });
    function Value() {
      useDomainUpdates(updates);
      return createElement("span", null, domain.store.get().value);
    }
    act(() => {
      root = createRoot(host);
      root.render(createElement(Value));
    });
    expect(host.textContent).toBe("before");
    act(() => {
      domain.controller.write((record) => {
        record.value = "after";
      });
    });
    expect(host.textContent).toBe("after");
    stop();
  });

  test("a mounted page follows later publishes and stops when unmounted", () => {
    const updates = createDomainUpdates([{ store: preferencesStore as unknown as DomainStore<object> }]);
    act(() => {
      root = createRoot(host);
      root.render(<Page updates={updates} />);
    });
    expect(host.querySelector(".group")?.textContent).toBe("flat");
    act(() => setListGroup("agent"));
    expect(host.querySelector(".group")?.textContent).toBe("agent");
    act(() => {
      root?.unmount();
      root = null;
    });
    act(() => setListGroup("flat"));
    expect(host.querySelector(".group")).toBeNull();
    expect(listGroup()).toBe("flat");
  });
});
