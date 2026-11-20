// Read the same player pixel on both paths. A compositor callback can be late
// even when video.getVideoPlaybackQuality() shows continuing presentation.
export function observeVideo(video, s, hooks) {
  const callbackOnly = new URLSearchParams(location.search).has('callbackOnly');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const pixels = canvas.getContext('2d', {willReadFrequently:true});
  let reader, clone, timer, closed = false;
  let previousCallback;
  const latest = () => s.traces.at(-1);

  function inspect(trigger, meta) {
    if (closed || video.readyState < 2 || !video.videoWidth) return;
    if (s.color !== undefined && s.pending === undefined) return;
    const readAt = performance.now();
    pixels.drawImage(video, video.videoWidth >> 1, video.videoHeight >> 1, 1, 1, 0, 0, 1, 1);
    const value = pixels.getImageData(0,0,1,1).data[0];
    if (value >= 32 && value <= 224) return;
    const light = value > 224;
    if (s.color === undefined) {
      s.color = light;
      hooks.ready();
    } else if (light !== s.color && s.pending !== undefined) {
      s.color = light;
      clearTimeout(timer);
      const row = latest();
      row.readback = performance.now() - readAt;
      row.observer = trigger;
      row.videoRtp = meta?.rtpTimestamp;
      hooks.complete(row, performance.now() - row.start);
    }
  }

  function poll() {
    inspect('timer');
    if (!closed && (s.pending !== undefined || s.color === undefined)) timer = setTimeout(poll, 8);
  }

  function presented(_, meta) {
    if (closed) return;
    const now = performance.now();
    const row = latest();
    if (row && previousCallback && previousCallback.at <= row.start && row.start <= now) {
      row.callbackGap = now - previousCallback.at;
      if (meta && previousCallback.frames !== undefined) {
        row.presentedBetweenCallbacks = meta.presentedFrames - previousCallback.frames;
      }
    }
    previousCallback = {at:now, frames:meta?.presentedFrames};
    inspect('callback', meta);
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(presented);
    else requestAnimationFrame(presented);
  }

  // Independent decoder-side diagnostic. Unsupported formats or processors do
  // not affect the player pixel measurement used for both comparison modes.
  async function readDecoded() {
    clone = video.srcObject.getVideoTracks()[0].clone();
    reader = new MediaStreamTrackProcessor({track:clone, maxBufferSize:1}).readable.getReader();
    try {
      while (!closed) {
        const {value:frame, done} = await reader.read();
        if (done) break;
        try {
          const row = latest();
          if (!row || row.decoded !== undefined) continue;
          const {x,y,width,height} = frame.visibleRect;
          const rect = {x:(x + width/2) & ~1, y:(y + height/2) & ~1, width:2, height:2};
          const planar = ['NV12','I420','I422','I444','I420A'].includes(frame.format);
          const options = planar ? {rect} : {rect,format:'RGBA'};
          const bytes = new Uint8Array(frame.allocationSize(options));
          const planes = await frame.copyTo(bytes, options);
          const value = bytes[planes[0].offset];
          if (!closed && (row.light ? value > 210 : value < 32)) {
            row.decoded = performance.now() - row.start;
            if (latest() === row) hooks.trace(row);
          }
        } finally {frame.close();}
      }
    } finally {clone.stop();}
  }

  if (typeof MediaStreamTrackProcessor === 'function') readDecoded().catch(() => clone?.stop());
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(presented);
  else requestAnimationFrame(presented);
  if (!callbackOnly) timer = setTimeout(poll, 8);
  return {
    flip() {
      clearTimeout(timer);
      if (!callbackOnly) timer = setTimeout(poll, 8);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      reader?.cancel().catch(() => {});
      clone?.stop();
    }
  };
}
