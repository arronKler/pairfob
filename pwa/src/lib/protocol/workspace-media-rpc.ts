import { ProtocolError } from './errors';
import { scopeHerdSession } from './herd-sessions';
import { isRecord } from './session-message';
import { MEDIA_OPEN_RPC_TIMEOUT_MS, type SessionTransport } from './session-transport';
import { parseWorkspaceMediaChunk, parseWorkspaceMediaOpen, type MediaReadOptions } from './workspace-media';

/** Media admission is checked on the captured transport, after any switch settles. */
export class WorkspaceMediaRPC {
  constructor(
    private capture: () => Promise<SessionTransport | null>,
    private herdSession: () => string | null,
  ) {}

  private async transport(options?: MediaReadOptions): Promise<SessionTransport> {
    const transport = await this.capture();
    if (!transport) throw new ProtocolError('reconnecting', '连接正在恢复');
    if (options?.requireDirect && transport.kind !== 'p2p') throw new ProtocolError('p2p_required');
    return transport;
  }

  open = async (paneId: string, path: string, root?: string, options?: MediaReadOptions) => {
    const op = root === undefined ? 'WorkspaceMediaOpen' : 'WorkspaceMediaOpenAtRoot';
    const params = scopeHerdSession(op, { pane_id: paneId, path, ...(root === undefined ? {} : { root }) }, this.herdSession());
    const transport = await this.transport(options);
    return parseWorkspaceMediaOpen(await transport.rpc(op, params, MEDIA_OPEN_RPC_TIMEOUT_MS, undefined, result => {
      // Late Open cleanup stays on its original epoch, never on a replacement connection.
      if (!isRecord(result) || typeof result.handle !== 'string' || !/^media_[0-9a-f]{32}$/u.test(result.handle)) return;
      void transport.rpc('WorkspaceMediaClose', { handle: result.handle }).catch(() => undefined);
    }));
  };

  read = async (handle: string, offset: number, length: number, options?: MediaReadOptions) => {
    const transport = await this.transport(options);
    return parseWorkspaceMediaChunk(await transport.rpc('WorkspaceMediaRead', { handle, offset, length }));
  };
}
