// Reading a log that is written as one zstd frame per append: the frames simply follow one another, so the end of
// the file can be read without the beginning, as long as a frame's start can be found.
import * as zlib from "node:zlib";

type Decoder = (buf: Buffer, options: { info: true }) => { buffer: Buffer; engine: { bytesWritten: number } };
// Node has zstd since 22.15; the typings do not carry the `info` form, which is what says where a frame ended.
const decoder = (zlib as unknown as { zstdDecompressSync?: Decoder }).zstdDecompressSync;

export const zstdAvailable = typeof decoder === "function";

/** Every zstd frame starts with these four bytes. They can also turn up inside a frame, so a hit is only a guess. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_STARTS = 64;

/** Decodes frame after frame from `start`, as far as it goes. */
function framesFrom(buf: Buffer, start: number): { text: string; end: number } {
  const parts: Buffer[] = [];
  let at = start;
  while (decoder && at < buf.length) {
    try {
      const frame = decoder(buf.subarray(at), { info: true });
      const used = frame.engine.bytesWritten;
      if (!used) break;
      parts.push(frame.buffer);
      at += used;
    } catch {
      break;
    }
  }
  return { text: Buffer.concat(parts).toString("utf8"), end: at };
}

/**
 * The text of the frames in `buf`. With `fromFrameStart` the buffer begins on a frame (the head of a file);
 * without, it is a slice from somewhere in the middle, and the first place from which the frames decode through to
 * the end is taken as the first whole frame. A last frame that is cut short (the file was being written) gives
 * what there is of it, so the text can end in the middle of a line. Empty when nothing decodes, or where Node has
 * no zstd.
 */
export function zstdFramesText(buf: Buffer, fromFrameStart: boolean): string {
  let best = { text: "", end: -1 };
  let at = fromFrameStart ? 0 : buf.indexOf(MAGIC);
  for (let tries = 0; at >= 0 && tries < MAX_STARTS; tries++) {
    const got = framesFrom(buf, at);
    if (got.end === buf.length && got.text) return got.text;
    // Two starts that stop at the same place: the stop is real (a frame cut short), and the earlier start has more.
    if (got.end > at && got.end === best.end) break;
    if (got.end > best.end) best = got;
    if (fromFrameStart) break;
    at = buf.indexOf(MAGIC, at + 1);
  }
  return best.text;
}
