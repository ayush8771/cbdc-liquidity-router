/*
 * An incremental Server-Sent Events parser for a decoded text stream (AD-1 §3.3.3 "Wire parsing").
 * `fetch` delivers bytes, so the caller decodes with a streaming, fatal TextDecoder and feeds strings
 * here; a chunk boundary may fall anywhere, including inside a field name or a JSON string.
 *
 * - Line endings: \r\n, \n and a lone \r all end a line.
 * - Only `event:` and `data:` are used; one optional space after the colon is stripped.
 * - A line starting with ":" is a comment: ignored, but the caller still counts the bytes as traffic.
 * - An event is dispatched at a blank line, and only if it had at least one `data:` line. Every completed
 *   event is returned and released at once, so many valid events in one chunk never add up.
 * - Two independent limits, both in UTF-8 bytes (the parser sees decoded text, so it counts the bytes each
 *   character takes when encoded, `utf8Bytes`, not the string length):
 *     MAX_PAYLOAD_BYTES  one event's JSON data: the data values joined by "\n" (only the real separators).
 *                        Field names, `event:` lines and comments are framing and never count toward it.
 *     MAX_BUFFER_BYTES   everything held for the event in progress: the unfinished line, the data lines so far
 *                        and the event name. It bounds memory whatever the framing looks like.
 */
export const MAX_PAYLOAD_BYTES = 65536;
export const MAX_BUFFER_BYTES = 131072;

/** Bytes one UTF-16 code unit takes in UTF-8: 1, 2 or 3, and 2 for each half of a surrogate pair (4 bytes together). Decoded text has no lone surrogates. */
function unitBytes(code: number): number {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3;
}

export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) bytes += unitBytes(text.charCodeAt(i));
  return bytes;
}

export type SseEvent = { event: string; data: string };

export type SseFeedResult = { events: SseEvent[]; overflow: boolean };

export class SseParser {
  private line = "";
  /** UTF-8 bytes of `line`. */
  private lineBytes = 0;
  private eventName: string | null = null;
  /** UTF-8 bytes of `eventName`. */
  private eventBytes = 0;
  private dataLines: string[] = [];
  /** UTF-8 bytes of the data lines joined by "\n": the JSON payload so far. */
  private payloadBytes = 0;
  /** The previous chunk ended in \r, so a leading \n belongs to that line ending. */
  private skipLf = false;
  private dead = false;

  feed(chunk: string): SseFeedResult {
    const events: SseEvent[] = [];
    if (this.dead) return { events, overflow: true };
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i] as string;
      if (this.skipLf) {
        this.skipLf = false;
        if (ch === "\n") continue;
      }
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r") this.skipLf = true;
        const emitted = this.endLine();
        if (emitted) events.push(emitted);
        if (this.dead) return { events, overflow: true };
      } else {
        this.line += ch;
        this.lineBytes += unitBytes(ch.charCodeAt(0));
      }
      if (this.lineBytes + this.payloadBytes + this.eventBytes > MAX_BUFFER_BYTES) return this.kill(events);
    }
    return { events, overflow: false };
  }

  private kill(events: SseEvent[]): SseFeedResult {
    this.dead = true;
    this.line = "";
    this.lineBytes = 0;
    this.dataLines = [];
    this.payloadBytes = 0;
    this.eventName = null;
    this.eventBytes = 0;
    return { events, overflow: true };
  }

  private endLine(): SseEvent | null {
    const line = this.line;
    this.line = "";
    this.lineBytes = 0;
    if (line === "") {
      const dispatched = this.dataLines.length > 0 ? { event: this.eventName ?? "message", data: this.dataLines.join("\n") } : null;
      this.eventName = null;
      this.eventBytes = 0;
      this.dataLines = [];
      this.payloadBytes = 0;
      return dispatched;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") {
      this.eventName = value;
      this.eventBytes = utf8Bytes(value);
    } else if (name === "data") {
      this.payloadBytes += utf8Bytes(value) + (this.dataLines.length > 0 ? 1 : 0); // one "\n" between lines, none before the first
      this.dataLines.push(value);
      if (this.payloadBytes > MAX_PAYLOAD_BYTES) this.kill([]);
    }
    return null;
  }
}
