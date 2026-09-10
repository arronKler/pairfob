import type { SessionEvent } from "../src/lib/protocol/session-types";
import type { Phase } from "../src/features/connection/connection-store";
import type { Screen } from "../src/app/navigation-store";

/**
 * QA fixture contract.
 *
 * The fixture is a Vite development HTML entry that mounts the SAME stable
 * production App (`src/app/mount.tsx`) with real domain actions, a real commit
 * boundary and the production session-owner seam. There is no baseline DOM
 * branch, no duplicate shell orchestrator and no paint fallback: a scene change
 * resets named domains and commits, and the App renders itself.
 *
 * This file is the browser-facing surface (`window.qa`). The fixture never
 * exposes a mutable whole-app state bag — callers drive named domain actions
 * (`setScene`, `setConnected`, `hold`, `release`, `failNext`, `emit`) and read
 * the snapshot.
 */
export type FixtureTerminalFrame = { full?: boolean; sequence?: string; cols?: number; rows?: number };

export type FixtureMode = "react";
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
  phase: Phase;
  screen: Screen;
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
};

declare global {
  interface Window { qa: FixtureAPI; }
}