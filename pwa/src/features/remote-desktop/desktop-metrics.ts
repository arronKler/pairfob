// Receiver counters are cumulative seconds and frames for one inbound RTP stream.
// Differences must come from the same stream and an advancing sampling window.
function measured(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function delta(current: number | undefined, previous: number | undefined) {
  if (current === undefined || previous === undefined || !Number.isFinite(current) || !Number.isFinite(previous)) return undefined;
  return previous >= 0 && current >= previous ? current - previous : undefined;
}

function meanMilliseconds(seconds: number | undefined, frames: number | undefined) {
  if (seconds === undefined || !frames) return undefined;
  return seconds * 1000 / frames;
}

export class DesktopMetrics {
  private previous?: RTCInboundRtpStreamStats;
  private submittedAt = -Infinity;
  private compositorMS?: number;

  frame(now: number, metadata: Pick<VideoFrameCallbackMetadata, "presentationTime" | "expectedDisplayTime">) {
    this.submittedAt = Math.min(now, metadata.presentationTime);
    this.compositorMS = delta(metadata.expectedDisplayTime, metadata.presentationTime);
  }

  sample(report: RTCStatsReport, element: Pick<HTMLVideoElement, "videoWidth" | "videoHeight">, encodeMS?: number, now = performance.now()) {
    let inbound: RTCInboundRtpStreamStats | undefined;
    let nominated: RTCIceCandidatePairStats | undefined;
    report.forEach(stat => {
      if (stat.type === "inbound-rtp" && (stat.kind === "video" || stat.mediaType === "video")) inbound = stat;
      if (stat.type === "candidate-pair" && stat.nominated && stat.state === "succeeded") nominated = stat;
    });
    const video = inbound;
    if (!video) {
      this.previous = undefined;
      return null;
    }
    const transport = video.transportId ? report.get(video.transportId) : undefined;
    const pair: RTCIceCandidatePairStats | undefined = report.get(transport?.selectedCandidatePairId) ?? nominated;
    const previous = this.previous;
    const elapsedMS = previous ? video.timestamp - previous.timestamp : 0;
    // Polling pauses when the panel closes. Start a new window when reopened.
    const sameWindow = previous && previous.id === video.id && previous.ssrc === video.ssrc && elapsedMS > 0 && elapsedMS <= 3000;
    let jitterBufferMS, decodeMS, receivedMbps;
    if (sameWindow) {
      jitterBufferMS = meanMilliseconds(delta(video.jitterBufferDelay, previous.jitterBufferDelay),
        delta(video.jitterBufferEmittedCount, previous.jitterBufferEmittedCount));
      decodeMS = meanMilliseconds(delta(video.totalDecodeTime, previous.totalDecodeTime),
        delta(video.framesDecoded, previous.framesDecoded));
      const bytes = delta(video.bytesReceived, previous.bytesReceived);
      if (bytes !== undefined) receivedMbps = bytes * 8 / (elapsedMS * 1000);
    }
    this.previous = video;
    const rtt = measured(pair?.currentRoundTripTime);
    const frameAge = now - this.submittedAt;
    return {
      width: video.frameWidth || element.videoWidth, height: video.frameHeight || element.videoHeight,
      fps: measured(video.framesPerSecond), dropped: measured(video.framesDropped),
      protocol: pair ? report.get(pair.localCandidateId)?.protocol as string | undefined : undefined,
      rttMS: rtt === undefined ? undefined : rtt * 1000, receivedMbps, jitterBufferMS, decodeMS,
      encodeMS: measured(encodeMS),
      compositorMS: frameAge >= 0 && frameAge <= 1500 ? this.compositorMS : undefined,
    };
  }
}

export type DesktopMetricSample = NonNullable<ReturnType<DesktopMetrics["sample"]>>;
