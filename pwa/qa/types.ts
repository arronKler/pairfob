import type { AppState } from "../src/state";
import type { SessionEvent } from "../src/lib/protocol/session-types";

export type FixtureTerminalFrame = { full?: boolean; sequence?: string; cols?: number; rows?: number };

export type FixtureMode = "baseline" | "react";
export type FixtureCall = { sequence: number; kind: "read" | "mutation" | "lifecycle" | "network"; method: string; args: unknown[] };
export type FixtureScene = { name: string; description: string; shellOnly?: boolean };
export type FixtureRect = { x: number; y: number; width: number; height: number };
export type FixtureSnapshot = {
  scene: string;
  mode: FixtureMode;
  ready: boolean;
  shellOnly: boolean;
  reactOwned: boolean;
  reactElements: number;
  viewport: { width: number; height: number; scale: number };
  timezone: string;
  language: string;
  appClass: string;
  bodyClass: string;
  rootClass: string;
  phase: AppState["phase"];
  screen: AppState["screen"];
  overflow: { documentX: number; appX: number };
  rects: Record<string, FixtureRect[]>;
  inputs: Array<{ nodeId: number; selector: string; value: string; focused: boolean; selection: [number | null, number | null] }>;
  calls: FixtureCall[];
  errors: string[];
};
export type FixtureAPI = {
  mode: FixtureMode;
  scenes: FixtureScene[];
  ready: Promise<void>;
  setScene(name: string): Promise<FixtureSnapshot>;
  setLanguage(language: "zh" | "en"): Promise<FixtureSnapshot>;
  render(): Promise<FixtureSnapshot>;
  snapshot(): FixtureSnapshot;
  calls: FixtureCall[];
  clearCalls(): void;
  setConnected(connected: boolean): void;
  emit(event: SessionEvent): void;
  terminalFrame(text: string, options?: FixtureTerminalFrame): boolean;
  hold(method: string): void;
  release(method: string): void;
  failNext(method: string, code: string): void;
  state: AppState;
};

declare global {
  interface Window { qa: FixtureAPI; }
}
