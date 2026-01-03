// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

async function listen(app, port = 0) {
  return await new Promise((resolve) => {
    app.server.listen(port, () => {
      const addr = app.server.address();
      resolve({ port: addr.port, close: () => app.close() });
    });
  });
}

function makeFakeSpawner({ listLines = [], downloadLines = [], exitCode = 0 } = {}) {
  return (args) => {
    // Minimal ChildProcessWithoutNullStreams mock
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();

    const isList = args.includes("--flat-playlist") && args.includes("--dump-json");
    const isDownload = args.includes("-a") && args.includes("--newline");
    const lines = isList ? listLines : isDownload ? downloadLines : [];

    queueMicrotask(() => {
      for (const l of lines) child.stdout.write(l + "\n");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", exitCode);
    });
    return child;
  };
}

function makeErrorSpawner({ code = "ENOENT", message = "spawn yt-dlp ENOENT" } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();

    queueMicrotask(() => {
      const err = new Error(message);
      err.code = code;
      child.emit("error", err);
    });

    return child;
  };
}

describe("ytdlp-ui server", () => {
  it("GET /api/doctor returns ok=false when yt-dlp cannot be spawned", async () => {
    const { createAppServer } = await import("../server.mjs");
    const app = createAppServer({ spawnYtDlp: makeErrorSpawner() });
    const s = await listen(app);

    const res = await fetch(`http://localhost:${s.port}/api/doctor`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/cannot spawn yt-dlp/i);

    await s.close();
  });

  it("GET /api/list returns parsed videos", async () => {
    const { createAppServer } = await import("../server.mjs");
    const fakeSpawn = makeFakeSpawner({
      listLines: [
        JSON.stringify({ id: "f4g1xtyY3uo", title: "Short 1" }),
        JSON.stringify({ id: "gAnS4WTgeIE", title: "Short 2" }),
        "not json",
      ],
    });
    const app = createAppServer({ spawnYtDlp: fakeSpawn });
    const s = await listen(app);

    const res = await fetch(`http://localhost:${s.port}/api/list?url=${encodeURIComponent("https://example.com")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.videos).toEqual([
      { id: "f4g1xtyY3uo", title: "Short 1", url: "https://www.youtube.com/watch?v=f4g1xtyY3uo" },
      { id: "gAnS4WTgeIE", title: "Short 2", url: "https://www.youtube.com/watch?v=gAnS4WTgeIE" },
    ]);

    await s.close();
  });

  it("GET /api/list returns 500 when yt-dlp cannot be spawned", async () => {
    const { createAppServer } = await import("../server.mjs");
    const app = createAppServer({ spawnYtDlp: makeErrorSpawner() });
    const s = await listen(app);

    const res = await fetch(`http://localhost:${s.port}/api/list?url=${encodeURIComponent("https://example.com")}`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/set ytdlp_bin/i);

    await s.close();
  });

  it("POST /api/download validates outDir and ids", async () => {
    const { createAppServer } = await import("../server.mjs");
    const app = createAppServer({ spawnYtDlp: makeFakeSpawner() });
    const s = await listen(app);

    const res = await fetch(`http://localhost:${s.port}/api/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outDir: "Z:\\\\definitely-not-a-real-dir", ids: ["f4g1xtyY3uo"] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/outDir must exist/i);

    await s.close();
  });
});


