import net from "node:net";

export const MAX_BYTES = 10 * 1024 * 1024; // matches the files.size_bytes database limit
const CHUNK = 64 * 1024;

/** Parse a clamd reply such as "stream: OK", "stream: Eicar-Test-Signature FOUND" or "INSTREAM size limit exceeded. ERROR". */
export function parseReply(reply) {
  const text = reply.replace(/\0/g, "").trim();
  if (/ERROR$/.test(text)) return { status: "error", detail: text };
  const found = text.match(/^stream:\s+(.+)\s+FOUND$/);
  if (found) return { status: "infected", detail: found[1] };
  if (/^stream:\s+OK$/.test(text)) return { status: "clean", detail: "OK" };
  return { status: "error", detail: text || "empty reply" };
}

/** Frame a buffer using clamd's INSTREAM protocol: zINSTREAM\0, then [4-byte big-endian length][bytes]..., then a zero length. */
export function frames(buffer) {
  const out = [Buffer.from("zINSTREAM\0")];
  for (let i = 0; i < buffer.length; i += CHUNK) {
    const part = buffer.subarray(i, i + CHUNK);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(part.length);
    out.push(len, part);
  }
  out.push(Buffer.alloc(4));
  return out;
}

/** Scan a buffer with clamd over TCP. Resolves to { status: clean|infected|error, detail }. Never resolves "clean" on any failure. */
export function scanBuffer(buffer, { host = "127.0.0.1", port = 3310, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    if (buffer.length > MAX_BYTES) return resolve({ status: "error", detail: "file exceeds the scan size limit" });
    const socket = net.createConnection({ host, port });
    let reply = "";
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; socket.destroy(); resolve(r); } };
    socket.setTimeout(timeoutMs, () => done({ status: "error", detail: "clamd timed out" }));
    socket.on("error", (e) => done({ status: "error", detail: `clamd connection failed: ${e.message}` }));
    socket.on("data", (d) => { reply += d.toString("utf8"); });
    socket.on("end", () => done(parseReply(reply)));
    socket.on("close", () => done(parseReply(reply)));
    socket.on("connect", () => { for (const f of frames(buffer)) socket.write(f); });
  });
}

/** True when clamd answers PING with PONG. */
export function ping({ host = "127.0.0.1", port = 3310, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    let r = "";
    s.setTimeout(timeoutMs, () => { s.destroy(); resolve(false); });
    s.on("error", () => resolve(false));
    s.on("data", (d) => { r += d; });
    s.on("close", () => resolve(r.includes("PONG")));
    s.on("connect", () => s.write("zPING\0"));
  });
}
