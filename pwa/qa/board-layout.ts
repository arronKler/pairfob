import type { SnapshotWire } from "../src/lib/dashboard";
import { parseSnapshotLayouts, type LayoutRect, type LayoutSplit, type TabLayout } from "../src/lib/layout";
import type { SplitPaneInput, SwapPaneInput, ResizePaneInput, ZoomPaneInput } from "../src/lib/operations";
import { herdrNeighbor } from "../src/features/board/model/pane-menu";

type Leaf = { pane: string };
type Split = { direction: "right" | "down"; ratio: number; first: Node; second: Node };
type Node = Leaf | Split;
type Tab = { layout: TabLayout; root: Node | null; zoomedPane: string };

const isLeaf = (node: Node): node is Leaf => "pane" in node;
const clamp = (ratio: number) => Math.min(0.9, Math.max(0.1, ratio));

/** Guillotine tree from the fixture's pane rects; ratios are exact at the drawn cells. */
function build(box: LayoutRect, panes: TabLayout["panes"]): Node {
  if (panes.length === 1) return { pane: panes[0].paneId };
  for (const direction of ["right", "down"] as const) {
    const across = direction === "right";
    const start = across ? box.x : box.y;
    const size = across ? box.width : box.height;
    const cuts = [...new Set(panes.map(({ rect }) => (across ? rect.x + rect.width : rect.y + rect.height)))]
      .filter((cut) => cut > start && cut < start + size).sort((a, b) => a - b);
    for (const cut of cuts) {
      const first = panes.filter(({ rect }) => (across ? rect.x + rect.width : rect.y + rect.height) <= cut);
      const second = panes.filter(({ rect }) => (across ? rect.x : rect.y) >= cut);
      if (!first.length || !second.length || first.length + second.length !== panes.length) continue;
      return {
        direction, ratio: (cut - start) / size,
        first: build(across ? { ...box, width: cut - box.x } : { ...box, height: cut - box.y }, first),
        second: build(across ? { ...box, x: cut, width: box.x + box.width - cut } : { ...box, y: cut, height: box.y + box.height - cut }, second),
      };
    }
  }
  throw new Error("QA layout is not a split tree");
}

/** herdr's split_rect: first child = round(length × ratio) cells, second gets the rest. */
function place(node: Node, box: LayoutRect, path: string, panes: Map<string, LayoutRect>, splits: LayoutSplit[]): void {
  if (isLeaf(node)) { panes.set(node.pane, box); return; }
  const across = node.direction === "right";
  const first = Math.round((across ? box.width : box.height) * node.ratio);
  splits.push({ id: `split_${path || "root"}`, direction: node.direction, ratio: node.ratio, rect: box });
  place(node.first, across ? { ...box, width: first } : { ...box, height: first }, `${path}0`, panes, splits);
  place(node.second, across ? { ...box, x: box.x + first, width: box.width - first } : { ...box, y: box.y + first, height: box.height - first },
    `${path}1`, panes, splits);
}

function splitNodes(node: Node, box: LayoutRect, out: Array<{ node: Split; rect: LayoutRect; at: number }>): void {
  if (isLeaf(node)) return;
  const across = node.direction === "right";
  const first = Math.round((across ? box.width : box.height) * node.ratio);
  out.push({ node, rect: box, at: (across ? box.x : box.y) + first });
  splitNodes(node.first, across ? { ...box, width: first } : { ...box, height: first }, out);
  splitNodes(node.second, across ? { ...box, x: box.x + first, width: box.width - first } : { ...box, y: box.y + first, height: box.height - first }, out);
}

function replace(node: Node, match: (node: Node) => boolean, next: (node: Node) => Node): Node {
  if (match(node)) return next(node);
  if (isLeaf(node)) return node;
  return { ...node, first: replace(node.first, match, next), second: replace(node.second, match, next) };
}

function leaves(node: Node | null, out: string[] = []): string[] {
  if (!node) return out;
  if (isLeaf(node)) out.push(node.pane);
  else { leaves(node.first, out); leaves(node.second, out); }
  return out;
}

function without(node: Node, pane: string): Node | null {
  if (isLeaf(node)) return node.pane === pane ? null : node;
  const first = without(node.first, pane);
  const second = without(node.second, pane);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

/**
 * Deterministic layout fixture for UI feedback. It keeps a split tree per tab
 * and applies herdr 0.9's rules (src/layout.rs): resize moves the split on the
 * pane's requested edge (else the opposite one) right/down by +amount and
 * left/up by −amount, clamped to 0.1–0.9; zoom shows only the zoomed pane.
 */
export function boardLayoutFixture(snapshot: SnapshotWire) {
  const tabs: Tab[] = parseSnapshotLayouts(snapshot).map((layout) => ({ layout, root: build(layout.area, layout.panes), zoomedPane: "" }));
  let serial = 10;
  const draw = (tab: Tab) => {
    const panes = new Map<string, LayoutRect>();
    const splits: LayoutSplit[] = [];
    if (tab.root) place(tab.root, tab.layout.area, "", panes, splits);
    // Like herdr 0.9 (checked against a live session): a zoomed tab still reports
    // every pane and split; `zoomed` marks it and the zoomed pane holds focus.
    if (tab.zoomedPane) tab.layout.focusedPaneId = tab.zoomedPane;
    tab.layout.panes = [...panes].map(([paneId, rect]) => ({ paneId, focused: paneId === tab.layout.focusedPaneId, rect }));
    tab.layout.splits = splits;
    tab.layout.zoomed = !!tab.zoomedPane;
  };
  const publish = () => {
    for (const tab of tabs) draw(tab);
    snapshot.layouts = tabs.filter((tab) => tab.layout.panes.length).map(({ layout }) => ({
      workspace_id: layout.workspaceId, tab_id: layout.tabId, area: layout.area,
      zoomed: layout.zoomed, focused_pane_id: layout.focusedPaneId,
      panes: layout.panes.map((pane) => ({ pane_id: pane.paneId, rect: pane.rect, focused: pane.focused })),
      splits: layout.splits,
    }));
  };
  // Targets come from the tree: a zoomed tab draws one pane but still holds them all.
  const target = (id: string) => {
    const tab = tabs.find((item) => leaves(item.root).includes(id));
    if (!tab) throw new Error("QA layout target missing");
    const lines = new Map<string, LayoutRect>();
    if (tab.root) place(tab.root, tab.layout.area, "", lines, []);
    return { tab, pane: { paneId: id, rect: lines.get(id)! } };
  };
  publish();
  return {
    split(input: SplitPaneInput) {
      const { tab } = target(input.pane_id);
      const original = snapshot.panes?.find((pane) => pane.pane_id === input.pane_id);
      const id = `${tab.layout.workspaceId}:p${++serial}`;
      tab.root = replace(tab.root!, (node) => isLeaf(node) && node.pane === input.pane_id, (leaf) =>
        ({ direction: input.direction, ratio: clamp(input.ratio ?? 0.5), first: leaf, second: { pane: id } }));
      snapshot.panes?.push({ ...original, workspace_id: tab.layout.workspaceId, tab_id: tab.layout.tabId,
        pane_id: id, cwd: input.cwd || original?.cwd, agent: input.agent_kind || "", agent_status: "idle", label: `New pane ${serial}` });
      publish();
      return { workspace_id: tab.layout.workspaceId, tab_id: tab.layout.tabId, pane_id: id };
    },
    swap(input: SwapPaneInput) {
      const { tab, pane } = target(input.pane_id);
      // herdr resolves a directional swap with find_in_direction; so does the board.
      const other = herdrNeighbor(tab.layout, pane.paneId, input.direction);
      if (other) {
        const [first, second] = [pane.paneId, other];
        tab.root = replace(tab.root!, (node) => isLeaf(node) && (node.pane === first || node.pane === second),
          (leaf) => ({ pane: (leaf as Leaf).pane === first ? second : first }));
      }
      publish();
    },
    resize(input: ResizePaneInput) {
      const { tab, pane } = target(input.pane_id);
      const rect = pane.rect;
      const lines: Array<{ node: Split; rect: LayoutRect; at: number }> = [];
      if (tab.root) splitNodes(tab.root, tab.layout.area, lines);
      const pick = (nav: string) => lines
        .filter(({ node }) => (nav === "left" || nav === "right") === (node.direction === "right"))
        .filter(({ rect: box }) => nav === "left" || nav === "right"
          ? box.y < rect.y + rect.height && rect.y < box.y + box.height
          : box.x < rect.x + rect.width && rect.x < box.x + box.width)
        .map((line) => ({ line, distance: Math.abs(line.at - (nav === "left" ? rect.x : nav === "right" ? rect.x + rect.width
          : nav === "up" ? rect.y : rect.y + rect.height)) }))
        .filter(({ distance }) => distance <= 1)
        .sort((a, b) => a.distance - b.distance)[0]?.line;
      const opposite = { left: "right", right: "left", up: "down", down: "up" }[input.direction];
      const line = pick(input.direction) ?? pick(opposite);
      if (line) {
        const amount = Math.min(0.5, Math.abs(input.amount ?? 0.05));
        line.node.ratio = clamp(line.node.ratio + (input.direction === "right" || input.direction === "down" ? amount : -amount));
      }
      publish();
    },
    zoom(input: ZoomPaneInput) {
      const { tab } = target(input.pane_id);
      const zoom = input.mode === "toggle" ? !tab.zoomedPane : input.mode === "on";
      tab.zoomedPane = zoom ? input.pane_id : "";
      tab.layout.focusedPaneId = input.pane_id;
      publish();
    },
    close(id: string) {
      for (const tab of tabs) {
        if (tab.root) tab.root = without(tab.root, id);
        if (tab.zoomedPane === id) tab.zoomedPane = "";
        // Focus moves to a pane that is still there, never a closed one.
        if (tab.layout.focusedPaneId === id) tab.layout.focusedPaneId = leaves(tab.root)[0] ?? "";
      }
      publish();
    },
  };
}
