import type { SessionEvent } from "../src/lib/protocol/session-types";
import type { ConnectionPhase } from "../src/lib/connection-phase";
import type { Phase } from "../src/features/connection/connection-store";
import type { Screen } from "../src/app/navigation-store";
import type { CompletionObservation } from "./completion-scenes";

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
  /** The session's own transport state, including a live path still being verified. */
  setConnectionPhase(phase: ConnectionPhase): void;
  emit(event: SessionEvent): void;
  appendChatTurn(): void;
  appendChatStep(): void;
  setAgentStatus(status: string): Promise<FixtureSnapshot>;
  setCompletionObservation(stage: CompletionObservation): Promise<FixtureSnapshot>;
  setExtraSessions(count: number): Promise<FixtureSnapshot>;
  refreshChat(): Promise<FixtureSnapshot>;
  terminalFrame(text: string, options?: FixtureTerminalFrame): boolean;
  hold(method: string): void;
  release(method: string): void;
  failNext(method: string, code: string): void;
  /** Configure the next update, or seed a completed record separately from the currently running build. */
  setDaemonUpdate(options: { ending?: "complete" | "failed" | "rolled_back"; supported?: boolean; build?: string; completedTarget?: string }): void;
  /** Move the frozen fixture clock on by `ms` until the next scene; returns the new time. */
  advanceClock(ms: number): number;
};

declare global {
  interface Window { qa: FixtureAPI; }
}
