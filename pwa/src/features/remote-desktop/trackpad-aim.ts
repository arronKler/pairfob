export type ScreenPoint = { x: number; y: number };

/** object-fit: contain, in the video's own CSS pixel coordinate space. */
export function pictureBox(width: number, height: number, sourceWidth: number, sourceHeight: number) {
  if (!width || !height || !sourceWidth || !sourceHeight) return null;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * scale, h = sourceHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

/** The capture already includes the real Mac cursor. Briefly mark the locally requested point. */
export function trackpadAim(video: HTMLVideoElement, ring: HTMLElement) {
  let last: ScreenPoint | null = null;
  let box: ReturnType<typeof pictureBox> = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  function hide() {
    last = null;
    clearTimeout(idle);
    ring.hidden = true;
  }
  function position() {
    if (!last) return;
    if (!box) return hide();
    const x = box.x + last.x * box.width, y = box.y + last.y * box.height;
    ring.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    ring.hidden = false;
  }
  function measure() {
    const rect = video.getBoundingClientRect();
    box = pictureBox(rect.width, rect.height, video.videoWidth, video.videoHeight);
    position();
  }
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(video);
  video.addEventListener("resize", measure);
  return {
    show(point: ScreenPoint) {
      last = point;
      position();
      clearTimeout(idle);
      idle = setTimeout(hide, 400);
    },
    hide,
    dispose() { hide(); observer.disconnect(); video.removeEventListener("resize", measure); },
  };
}
