// Pairfob session observation: managed file.
import { execFile } from 'node:child_process';

export default function (cmd) {
  const ownsPane = () => process.env.HERDR_ENV === '1' && process.env.HERDR_PANE_ID && process.env.HERDR_SOCKET_PATH &&
    (!process.env.CMD_HERDR_PANE_OWNER || process.env.CMD_HERDR_PANE_OWNER === String(process.pid));
  if (!ownsPane()) return;
  let id, activity, previous;
  let sequence = 0;
  let pending, running = false;
  const drain = () => {
    if (running || !pending) return;
    const body = pending;
    pending = undefined;
    running = true;
    const child = execFile(PAIRFOB_BINARY, ['agent-hook', 'cmd'], { timeout: 3500, maxBuffer: 4096 }, () => {
      running = false;
      drain();
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(body));
  };
  const report = (clear = false, force = false) => {
    if (!id || !ownsPane()) return;
    let leaf;
    try { leaf = cmd.sessions.leafId() ?? ''; } catch { return; }
    const body = { session_id: id, leaf, clear, activity };
    const signature = JSON.stringify(body);
    if (!force && signature === previous) return;
    previous = signature;
    sequence = Math.max(sequence + 1, Number(process.hrtime.bigint() / 1000n));
    pending = { ...body, sequence };
    drain();
  };
  cmd.hooks({
    onSessionStart({ sessionId }) { id = sessionId; activity = undefined; report(false, true); },
    onSessionEnd({ reason }) { if (reason !== 'reload') report(true, true); id = undefined; },
  });
  cmd.on('run_start', event => { id = event.sessionId; activity = undefined; report(false, true); });
  for (const type of ['tool_running', 'tool_completed', 'tool_errored']) {
    cmd.on(type, event => {
      activity = { type: 'tool', name: event.toolName, at: Date.now(),
        state: type === 'tool_running' ? '' : type === 'tool_errored' ? 'error' : 'done' };
      report();
    });
  }
  cmd.on('run_end', () => { activity = undefined; report(false, true); });
  // Branch navigation has no dedicated event. Observe its live pointer without
  // changing the transcript, and retry reports that preceded process detection.
  cmd.clock.every(1500, () => report(false, true));
}
