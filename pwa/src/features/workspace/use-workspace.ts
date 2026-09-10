import { useSyncExternalStore } from "react";
import { getWorkspaceSnapshot, subscribeWorkspace, type WorkspaceSnapshot } from "./store";

export function useWorkspace(): WorkspaceSnapshot {
  return useSyncExternalStore(subscribeWorkspace, getWorkspaceSnapshot, getWorkspaceSnapshot);
}
