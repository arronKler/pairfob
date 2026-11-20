import type { DesktopObservation } from "../../lib/protocol/remote-desktop";

const inputWindow = 1800, recoveryInterval = 2000;
const streamTimeout = 6500, firstFrameTimeout = 15000;

export class DesktopFrameHealth {
  private lastFrame?: number;
  private stamp?: number;
  private lastProof = -Infinity;
  private proofMatches = false;
  private supported = false;
  private lastRecovery = -Infinity;
  constructor(private opened: number) {}

  presented(now: number, stamp?: number) {
    this.lastFrame = now;
    this.stamp = stamp;
  }

  // Legacy receivers can verify playback progress without RTP metadata.
  playbackProgress(now: number) {
    if (!this.observe) this.lastFrame = now;
  }

  get observe() { return this.supported && this.stamp !== undefined; }

  observed(state: DesktopObservation | void, sentAt: number) {
    this.supported = !!state;
    this.proofMatches = !!state && state.healthy && this.stamp === state.rtp_time;
    if (this.proofMatches) this.lastProof = sentAt;
  }

  allowsInput(now: number) {
    return this.lastFrame !== undefined && (now - this.lastFrame <= inputWindow ||
      (this.proofMatches && now - this.lastProof <= inputWindow));
  }

  expired(now: number) {
    if (this.lastFrame === undefined) return now - this.opened > firstFrameTimeout;
    return now - Math.max(this.lastFrame, this.lastProof) > streamTimeout;
  }

  requestKeyframe(now: number) {
    if (!this.observe || this.allowsInput(now) || now - this.lastRecovery < recoveryInterval) return false;
    this.lastRecovery = now;
    return true;
  }
}
