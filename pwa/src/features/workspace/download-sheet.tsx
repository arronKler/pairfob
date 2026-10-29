import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { ProtocolError } from "../../lib/protocol/errors";
import type { LiveSession } from "../../lib/protocol/client";
import { DOWNLOAD_CHUNK_BYTES, DOWNLOAD_MAX_BYTES, type WorkspaceDownloadOpen } from "../../lib/protocol/workspace-download";
import type { ActionSheetController } from "../../shared/ui/overlay/action-sheet";
import { Button } from "../../shared/ui/primitives";
import { formatBytes } from "./format";
import { ensureServiceWorkerControl, serviceWorkerDownloadSupported, startServiceWorkerDownload, type ServiceWorkerDownload } from "./download-pump";
import { SHARE_MAX_BYTES, canOpenOnDevice, isShareCancel, openOnDevice, shareCandidate } from "./download-share";
import { fileSystemAccessAvailable, isPickerCancel, pickFileSink, type DownloadSink } from "./download-writer";
import "./workspace-download.scss";

type Phase = "opening" | "ready" | "saving" | "done" | "error";

type DownloadPanelProps = {
  session: LiveSession;
  paneId: string;
  path: string;
  root?: string;
  fallbackSize: number;
  modal: ActionSheetController;
};

function baseName(path: string): string {
  return path.split("/").pop() || path || "download";
}

function displayBytes(size: number): string {
  return size >= 1 << 30 ? `${(size / (1 << 30)).toFixed(1)} GiB` : formatBytes(size);
}

function downloadMessage(error: unknown, size: number): string {
  if (error instanceof ProtocolError) {
    switch (error.code) {
      case "p2p_required": return t("workspace.download.p2p");
      case "unknown_op": return t("workspace.download.update");
      case "too_large": return t("workspace.download.tooLarge", { size: displayBytes(size), cap: displayBytes(DOWNLOAD_MAX_BYTES) });
      case "conflict":
      case "workspace_not_found": return t("workspace.download.changed");
      case "forbidden": return t("workspace.download.forbidden");
      case "rate_limited": return t("workspace.download.busy");
      case "disconnected":
      case "reconnecting": return t("workspace.download.offline");
      case "unsupported": return error.message || t("workspace.download.unsupported");
      default: return error.message || t("workspace.download.failed");
    }
  }
  return error instanceof Error && error.message ? error.message : t("workspace.download.failed");
}

/**
 * The download sheet owns one P2P file handle for its lifetime. The file is
 * written through the File System Access picker when the browser has it, or
 * through the service-worker pump when it does not; the RPC layer rejects
 * relay before a single byte is requested.
 *
 * A finished file that the browser can share is kept for the sheet's "open or
 * share" action; the sheet hands it to the system instead of pretending the
 * app can open a path on disk.
 */
export function DownloadPanel({ session, paneId, path, root, fallbackSize, modal }: DownloadPanelProps) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>("opening");
  const [info, setInfo] = useState<WorkspaceDownloadOpen | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState("");
  const [viaServiceWorker, setViaServiceWorker] = useState(false);
  const [shareFile, setShareFile] = useState<File | null>(null);
  const [shareFailed, setShareFailed] = useState(false);
  const handleRef = useRef<string | null>(null);
  const sinkRef = useRef<DownloadSink | null>(null);
  const pumpRef = useRef<ServiceWorkerDownload | null>(null);
  const cancelRef = useRef(false);
  const aliveRef = useRef(true);
  const sharingRef = useRef(false);

  const total = info?.size ?? fallbackSize;
  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  const name = baseName(info?.path || path);

  const closeHandle = () => {
    const handle = handleRef.current;
    handleRef.current = null;
    if (handle) void session.workspaceDownloadClose?.(handle).catch(() => undefined);
  };

  useEffect(() => {
    aliveRef.current = true;
    cancelRef.current = false;
    sharingRef.current = false;
    setPhase("opening");
    setInfo(null);
    setLoaded(0);
    setError("");
    setShareFile(null);
    setShareFailed(false);
    if (!session.workspaceDownloadOpen || !session.workspaceDownloadRead) {
      setError(t("workspace.download.update"));
      setPhase("error");
      return;
    }
    void (async () => {
      try {
        const opened = await session.workspaceDownloadOpen!(paneId, path, root);
        if (!aliveRef.current) {
          void session.workspaceDownloadClose?.(opened.handle).catch(() => undefined);
          return;
        }
        handleRef.current = opened.handle;
        setInfo(opened);
        setPhase("ready");
      } catch (caught) {
        if (aliveRef.current) {
          setError(downloadMessage(caught, fallbackSize));
          setPhase("error");
        }
      }
    })();
    return () => {
      aliveRef.current = false;
      cancelRef.current = true;
      pumpRef.current?.cancel();
      pumpRef.current = null;
      const sink = sinkRef.current;
      sinkRef.current = null;
      if (sink) void sink.abort().catch(() => undefined);
      closeHandle();
    };
    // attempt intentionally retires the previous handle and opens a fresh one.
  }, [attempt, session, paneId, path, root, fallbackSize]);

  const start = async () => {
    if (!info || phase !== "ready") return;
    const handle = handleRef.current;
    const read = session.workspaceDownloadRead;
    if (!handle || !read) {
      setError(t("workspace.download.failed"));
      setPhase("error");
      return;
    }
    let offset = 0;
    let lastProgress = 0;
    // Holding the bytes is the whole price of "open or share", so nothing is
    // kept for a file too large to hand over, or for a browser that cannot
    // take one.
    const keepForShare = shareCandidate() && info.size <= SHARE_MAX_BYTES;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    const finishDone = () => {
      let share: File | null = null;
      if (keepForShare) {
        share = new File(parts, name, { type: info.mime });
        if (!canOpenOnDevice(share)) share = null;
      }
      closeHandle();
      if (!aliveRef.current) return;
      setShareFile(share);
      setPhase("done");
    };
    const reportProgress = (value: number) => {
      const now = Date.now();
      if (now - lastProgress < 50 && value !== info.size) return;
      lastProgress = now;
      if (aliveRef.current) setLoaded(value);
    };
    cancelRef.current = false;
    setPhase("saving");
    setLoaded(0);
    setError("");
    setViaServiceWorker(false);
    setShareFile(null);
    setShareFailed(false);
    const source = async () => {
      if (cancelRef.current) throw new DOMException("取消下载", "AbortError");
      const chunk = await read(handle, offset, DOWNLOAD_CHUNK_BYTES);
      if (chunk.handle !== handle || chunk.offset !== offset) {
        throw new ProtocolError("conflict", "download chunk mismatch");
      }
      offset += chunk.length;
      if (keepForShare) parts.push(new Uint8Array(chunk.bytes));
      reportProgress(offset);
      return { bytes: chunk.bytes, eof: chunk.eof };
    };
    try {
      let sink: DownloadSink | null = null;
      if (fileSystemAccessAvailable()) {
        try {
          // This call must stay synchronous from the click: the save picker
          // needs transient user activation.
          sink = await pickFileSink(name);
        } catch (pickerError) {
          if (isPickerCancel(pickerError)) {
            if (aliveRef.current) setPhase("ready");
            return;
          }
          // A WebView can expose the API and still refuse the picker. Fall
          // through to the service-worker route instead of failing here.
        }
      }
      if (sink) {
        if (!aliveRef.current || cancelRef.current) {
          await sink.abort().catch(() => undefined);
          return;
        }
        sinkRef.current = sink;
        for (;;) {
          const chunk = await source();
          await sink.write(chunk.bytes);
          if (offset > info.size) throw new ProtocolError("conflict", "download size mismatch");
          if (chunk.eof) break;
        }
        if (offset !== info.size) throw new ProtocolError("conflict", "download size mismatch");
        await sink.close();
        sinkRef.current = null;
        finishDone();
        return;
      }
      if (serviceWorkerDownloadSupported() || await ensureServiceWorkerControl()) {
        setViaServiceWorker(true);
        const pump = startServiceWorkerDownload({ name, size: info.size, mime: info.mime }, source);
        pumpRef.current = pump;
        await pump.promise;
        pumpRef.current = null;
        finishDone();
        return;
      }
      throw new ProtocolError("unsupported", t("workspace.download.unsupported"));
    } catch (caught) {
      const sink = sinkRef.current;
      sinkRef.current = null;
      if (sink) await sink.abort().catch(() => undefined);
      pumpRef.current = null;
      if (isPickerCancel(caught)) {
        if (aliveRef.current) setPhase("ready");
        return;
      }
      closeHandle();
      if (cancelRef.current) return;
      if (aliveRef.current) {
        setError(downloadMessage(caught, info.size));
        setPhase("error");
      }
    }
  };

  const cancel = () => {
    cancelRef.current = true;
    pumpRef.current?.cancel();
    pumpRef.current = null;
    const sink = sinkRef.current;
    sinkRef.current = null;
    if (sink) void sink.abort().catch(() => undefined);
    closeHandle();
    modal.dismiss();
  };

  const retry = () => {
    cancelRef.current = false;
    closeHandle();
    setAttempt(value => value + 1);
  };

  /** Called straight from the tap: the share sheet needs the same gesture. */
  const share = (file: File) => {
    // A second tap while the sheet is opening would be refused by the browser
    // and read as a failure of the first.
    if (sharingRef.current) return;
    sharingRef.current = true;
    setShareFailed(false);
    void openOnDevice(file).then(
      () => { sharingRef.current = false; },
      (caught: unknown) => {
        sharingRef.current = false;
        if (aliveRef.current && !isShareCancel(caught)) setShareFailed(true);
      },
    );
  };

  return <div className="workspace-download">
    <p className="workspace-download-name">{name}</p>
    <p className="workspace-row-meta">{displayBytes(total)} · {t("workspace.download.p2pShort")}</p>
    {phase === "opening" && <p className="workspace-download-note">{t("workspace.download.opening")}</p>}
    {phase === "ready" && <>
      <p className="workspace-download-note">{t("workspace.download.hint")}</p>
      <div className="workspace-download-actions">
        <Button className="btn btn-primary" onClick={() => void start()}>
          {fileSystemAccessAvailable() ? t("workspace.download.choose") : t("workspace.download.start")}
        </Button>
        <Button className="btn btn-small btn-ghost" onClick={() => modal.dismiss()}>{t("workspace.download.cancel")}</Button>
      </div>
    </>}
    {phase === "saving" && <>
      <div className="workspace-download-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={loaded}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="workspace-row-meta">{t("workspace.download.progress", {
        loaded: displayBytes(loaded), total: displayBytes(total), percent: String(percent),
      })}</p>
      <div className="workspace-download-actions">
        <Button className="btn btn-small btn-ghost" onClick={cancel}>{t("workspace.download.cancel")}</Button>
      </div>
    </>}
    {phase === "done" && <>
      <p className="workspace-download-note" role="status">
        {viaServiceWorker ? t("workspace.download.started") : t("workspace.download.done")}
      </p>
      {shareFailed && <p className="workspace-download-error" role="alert">{t("workspace.download.openFailed")}</p>}
      <div className="workspace-download-actions">
        {shareFile && <Button className="btn btn-small btn-primary" onClick={() => share(shareFile)}>
          {t("workspace.download.open")}
        </Button>}
        <Button className={`btn btn-small ${shareFile ? "btn-ghost" : "btn-primary"}`} onClick={() => modal.dismiss()}>
          {t("workspace.download.close")}
        </Button>
      </div>
    </>}
    {phase === "error" && <>
      <p className="workspace-download-error" role="alert">{error}</p>
      <div className="workspace-download-actions">
        <Button className="btn btn-small btn-primary" onClick={retry}>{t("workspace.download.retry")}</Button>
        <Button className="btn btn-small btn-ghost" onClick={() => modal.dismiss()}>{t("workspace.download.close")}</Button>
      </div>
    </>}
  </div>;
}
