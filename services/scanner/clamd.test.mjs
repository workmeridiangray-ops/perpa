import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { frames, parseReply, scanBuffer, ping, MAX_BYTES } from "./clamd.mjs";

/** A fake clamd that records the bytes it receives and answers with `reply`. */
function fake(reply, { silent = false } = {}) {
  const seen = [];
  const server = net.createServer((s) => {
    const chunks = [];
    s.on("data", (d) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      if (all.subarray(all.length - 4).equals(Buffer.alloc(4)) && all.includes("zINSTREAM")) { seen.push(all); if (!silent) s.end(reply); }
      if (all.toString().startsWith("zPING")) s.end("PONG\0");
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port, seen })));
}
let open = [];
afterEach(() => { open.forEach((s) => s.close()); open = []; });
const start = async (...a) => { const f = await fake(...a); open.push(f.server); return f; };

describe("parseReply", () => {
  it("understands OK, FOUND and errors", () => {
    expect(parseReply("stream: OK\0")).toEqual({ status: "clean", detail: "OK" });
    expect(parseReply("stream: Eicar-Test-Signature FOUND\0")).toEqual({ status: "infected", detail: "Eicar-Test-Signature" });
    expect(parseReply("INSTREAM size limit exceeded. ERROR\0").status).toBe("error");
    expect(parseReply("").status).toBe("error");
    expect(parseReply("something unexpected").status).toBe("error"); // never clean by default
  });
});

describe("frames", () => {
  it("uses the INSTREAM framing and ends with a zero-length chunk", () => {
    const f = frames(Buffer.from("hello"));
    expect(f[0].toString()).toBe("zINSTREAM\0");
    expect(f[1].readUInt32BE()).toBe(5);
    expect(f[2].toString()).toBe("hello");
    expect(f.at(-1).equals(Buffer.alloc(4))).toBe(true);
  });
  it("splits large buffers into 64 KiB chunks", () => {
    const f = frames(Buffer.alloc(150_000));
    expect(f.filter((x) => x.length === 4).length).toBe(4); // 3 chunk headers + terminator
  });
});

describe("scanBuffer", () => {
  it("returns clean, infected and error from the server's answer, sending the exact bytes", async () => {
    const data = Buffer.from("payload-bytes");
    const ok = await start("stream: OK\0");
    expect(await scanBuffer(data, { port: ok.port })).toMatchObject({ status: "clean" });
    expect(ok.seen[0].includes(data)).toBe(true);
    const bad = await start("stream: Win.Test.EICAR FOUND\0");
    expect(await scanBuffer(data, { port: bad.port })).toEqual({ status: "infected", detail: "Win.Test.EICAR" });
    const err = await start("INSTREAM size limit exceeded. ERROR\0");
    expect((await scanBuffer(data, { port: err.port })).status).toBe("error");
  });
  it("is never clean when clamd is unreachable, silent, or the file is too large", async () => {
    expect((await scanBuffer(Buffer.from("x"), { port: 1, timeoutMs: 500 })).status).toBe("error");
    const quiet = await start("", { silent: true });
    expect((await scanBuffer(Buffer.from("x"), { port: quiet.port, timeoutMs: 300 })).status).toBe("error");
    expect((await scanBuffer(Buffer.alloc(MAX_BYTES + 1))).status).toBe("error");
  });
  it("ping answers true only for PONG", async () => {
    const f = await start("x");
    expect(await ping({ port: f.port })).toBe(true);
    expect(await ping({ port: 1, timeoutMs: 300 })).toBe(false);
  });
});
