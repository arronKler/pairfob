// Pairfob session observation: managed file.
import { execFile } from 'node:child_process';

export default function (amp) {
  if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) return;
  if (!amp.activeThread?.subscribe || amp.system?.executor?.kind !== 'local') return;
  let previous = null;
  const tick = () => Number(process.hrtime.bigint() / 1000n);
  let sequence = tick();
  let queue = Promise.resolve();
  const report = (id, action) => {
    if (!id) return;
    sequence = Math.max(sequence + 1, tick());
    const args = ['agent-hook', 'amp', id, String(sequence), action];
    queue = queue.then(() => new Promise(resolve => {
      execFile(PAIRFOB_BINARY, args, { timeout: 3500, maxBuffer: 4096 }, () => resolve());
    }));
  };
  const observe = active => {
    const id = active?.id ?? null;
    if (!id && previous) report(previous, 'clear');
    if (id) report(id, 'bind');
    previous = id;
  };
  const subscription = amp.activeThread.subscribe(observe);
  observe(amp.activeThread.current);
  // Refresh at the first turn if startup preceded Herdr process detection.
  amp.on('agent.start', event => {
    if (event.thread.id === amp.activeThread.current?.id) observe(amp.activeThread.current);
  });
  amp.onDispose(() => { subscription.unsubscribe(); });
}
