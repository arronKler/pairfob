const CHUNK_HEADER_BYTES = 12;
const CHUNK_DATA_BYTES = 16 * 1024 - CHUNK_HEADER_BYTES;
const MAX_FRAME_BYTES = 24 + 262_144;
const MAGIC = new Uint8Array([0x50, 0x46, 0x50, 0x32]);

export function splitDirectFrame(frame: Uint8Array): Uint8Array[] {
  if (frame.length < 24 || frame.length > MAX_FRAME_BYTES) throw new Error("invalid P2P frame length");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < frame.length; offset += CHUNK_DATA_BYTES) {
    const end = Math.min(offset + CHUNK_DATA_BYTES, frame.length);
    const chunk = new Uint8Array(CHUNK_HEADER_BYTES + end - offset);
    chunk.set(MAGIC);
    const view = new DataView(chunk.buffer);
    view.setUint32(4, frame.length, false);
    view.setUint32(8, offset, false);
    chunk.set(frame.subarray(offset, end), CHUNK_HEADER_BYTES);
    chunks.push(chunk);
  }
  return chunks;
}

export class DirectFrameAssembler {
  private total = 0;
  private data = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array | null {
    if (chunk.length <= CHUNK_HEADER_BYTES || chunk.length > CHUNK_HEADER_BYTES + CHUNK_DATA_BYTES ||
        !MAGIC.every((value, index) => chunk[index] === value)) {
      throw new Error("invalid P2P chunk");
    }
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const total = view.getUint32(4, false);
    const offset = view.getUint32(8, false);
    const payloadBytes = chunk.length - CHUNK_HEADER_BYTES;
    if (total < 24 || total > MAX_FRAME_BYTES || offset >= total || offset + payloadBytes > total) {
      throw new Error("invalid P2P chunk bounds");
    }
    if (offset === 0) {
      if (this.data.length !== 0) throw new Error("interleaved P2P frame");
      this.total = total;
      this.offset = 0;
      this.data = new Uint8Array(total);
    }
    if (this.total !== total || offset !== this.offset) throw new Error("out-of-order P2P chunk");
    this.data.set(chunk.subarray(CHUNK_HEADER_BYTES), offset);
    this.offset += payloadBytes;
    if (this.offset !== this.total) return null;
    const frame = this.data;
    this.total = 0;
    this.offset = 0;
    this.data = new Uint8Array(0);
    return frame;
  }

  private offset = 0;
}
