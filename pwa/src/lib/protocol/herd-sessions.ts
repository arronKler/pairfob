/**
 * Herdr-session scoping for outgoing RPC params.
 *
 * One daemon connection can address several Herdr sessions (the default socket
 * plus `sessions/<name>`). The selected name rides in each op's `session` param,
 * but the daemon decodes params strictly, so only ops whose schema declares
 * `session` may carry it. Handle-keyed follow-ups (TerminalInput, media reads)
 * inherit the session their open bound and must not repeat it.
 *
 * The default session (`null`) leaves params untouched: the wire stays
 * byte-identical to a client that never heard of Herdr sessions, so older
 * daemons are unaffected.
 */
import { ProtocolError } from "./errors.ts";
import { exactKeys, isRecord } from "./session-message.ts";
import type { HerdSessionSummary } from "./session-types.ts";

export const HERD_SESSION_SCOPED_OPS: ReadonlySet<string> = new Set([
  "AgentInspect", "AgentTrace", "AgentTraceDetail", "AgentTraceSummary",
  "ClosePane", "CloseTab", "CloseWorkspace",
  "CreateConversation", "CreateTab", "CreateWorktree",
  "GetConfig", "GitBranches", "GitDiff", "GitStatus", "History",
  "ListWorktrees", "OpenWorktree", "PaneRead", "PromptAgent",
  "RenamePane", "RenameTab", "RenameWorkspace", "ResizePane",
  "SendKeys", "SendText", "Snapshot", "SplitPane", "SwapPane", "TerminalOpen",
  "WorkspaceDelete", "WorkspaceList", "WorkspaceMediaOpen", "WorkspaceOpen",
  "WorkspaceListAtRoot", "WorkspaceReadAtRoot", "WorkspaceMediaOpenAtRoot",
  "WorkspaceRead", "WorkspaceRename", "WorkspaceResolve",
  "WorkspaceUploadBegin", "WorkspaceUploadBeginV2", "WorkspaceUploadCancel", "WorkspaceUploadCancelV2",
  "WorkspaceUploadCommit", "WorkspaceUploadCommitV2", "WorkspaceUploadStatus", "WorkspaceUploadStatusV2",
  "WorkspaceUploadWrite", "WorkspaceUploadWriteV2", "ZoomPane",
]);

/** Herdr's session-name rule, mirrored from the daemon. */
const HERD_SESSION_NAME = /^[A-Za-z0-9._-]{1,128}$/u;

export function validHerdSessionName(name: string): boolean {
  return HERD_SESSION_NAME.test(name) && name !== "." && name !== "..";
}

/** Preserve default storage keys; named sessions have a distinct local namespace. */
export function herdSessionScope(daemonId: string, session: string | null): string {
  return session === null ? daemonId : `${daemonId}:herd:${session}`;
}

/** Params for `op` targeting `session`; the connection's selection is the one authority. */
export function scopeHerdSession(op: string, params: unknown, session: string | null): unknown {
  if (session === null || !HERD_SESSION_SCOPED_OPS.has(op)) return params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return params;
  return { ...(params as Record<string, unknown>), session };
}

/**
 * A ListSessions result, validated exactly like the schema: the default session
 * (`name: null`) first, then each named session once. Anything else is a
 * protocol mismatch, never a partially trusted list.
 */
export function parseHerdSessions(result: unknown): HerdSessionSummary[] {
  const bad = () => new ProtocolError("bad_message", "ListSessions 响应与协议不一致");
  if (!isRecord(result) || !exactKeys(result, ["sessions"]) || !Array.isArray(result.sessions)) throw bad();
  const seen = new Set<string>();
  const sessions = result.sessions.map((entry: unknown): HerdSessionSummary => {
    if (!isRecord(entry) || !exactKeys(entry, ["name", "running"]) || typeof entry.running !== "boolean") throw bad();
    const name = entry.name;
    if (name !== null && (typeof name !== "string" || !validHerdSessionName(name))) throw bad();
    const key = name ?? "";
    if (seen.has(key)) throw bad();
    seen.add(key);
    return { name, running: entry.running };
  });
  if (sessions[0]?.name !== null || sessions.length === 0) throw bad();
  return sessions;
}
