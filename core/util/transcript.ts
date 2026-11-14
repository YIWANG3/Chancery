// Reading a session's transcript without reading all of it: a file of one JSON object per line that can run to a
// hundred megabytes, of which only the head (what kind of session, where) and the tail (how it ended) matter.
import { open } from "node:fs/promises";

export async function readBytes(path: string, start: number, length: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export const readSlice = async (path: string, start: number, length: number): Promise<string> => (await readBytes(path, start, length)).toString("utf8");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The lines of a slice that are whole JSON objects; a line cut by the slice's edge simply does not parse. */
export const jsonLines = (text: string): Array<Record<string, unknown>> =>
  text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const v: unknown = JSON.parse(line);
      return isRecord(v) ? [v] : [];
    } catch {
      return [];
    }
  });

const TITLE_MAX = 80;
/** The first line of a text, cut to a title's length. */
export const firstLine = (s: string): string => {
  const line = s.trim().split("\n")[0]?.trim() ?? "";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};
