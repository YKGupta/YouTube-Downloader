// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function listen(app, port = 0) {
  return await new Promise((resolve) => {
    app.server.listen(port, () => {
      const addr = app.server.address();
      resolve({ port: addr.port, close: () => app.close() });
    });
  });
}

function makeFakeSpawner({ infoJson = null, listLines = [], downloadLines = [], exitCode = 0 } = {}) {
  return (args) => {
    // Minimal ChildProcessWithoutNullStreams mock
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();

    const isInfo = args.includes("-J");
    const isList = args.includes("--flat-playlist") && args.includes("--dump-json");
    const isDownload = args.includes("-a") && args.includes("--newline");

    queueMicrotask(() => {
      if (isInfo && infoJson) {
        child.stdout.write(JSON.stringify(infoJson) + "\n");
      } else {
        const lines = isList ? listLines : isDownload ? downloadLines : [];
        for (const l of lines) child.stdout.write(l + "\n");
      }
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

  it("GET /api/info returns ok=true and qualities for a video", async () => {
    const { createAppServer } = await import("../server.mjs");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-ui-test-"));
    const fakeSpawn = makeFakeSpawner({
      infoJson: {
        id: "f4g1xtyY3uo",
        title: "My Video",
        formats: [{ height: 720 }, { height: 360 }, { height: null }],
      },
    });
    const app = createAppServer({ spawnYtDlp: fakeSpawn, downloadsBaseDir: tmp });
    const s = await listen(app);

    const res = await fetch(`http://localhost:${s.port}/api/info?url=${encodeURIComponent("https://example.com")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.title).toBe("My Video");
    expect(body.qualities).toEqual([720, 360]);
    expect(body.mp3).toBe(true);

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

  it("POST /api/download requires either url or ids", async () => {
    const { createAppServer } = await import("../server.mjs");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-ui-test-"));
    const app = createAppServer({ spawnYtDlp: makeFakeSpawner(), downloadsBaseDir: tmp });
    const s = await listen(app);

    const res = await fetch(`http://localhost:${s.port}/api/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing url/i);

    await s.close();
  });

  it("POST /api/download starts a job for a single url and exposes /api/files/:jobId", async () => {
    const { createAppServer } = await import("../server.mjs");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-ui-test-"));
    const app = createAppServer({ spawnYtDlp: makeFakeSpawner(), downloadsBaseDir: tmp });
    const s = await listen(app);

    const res = await fetch(`http://localhost:${s.port}/api/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/watch?v=f4g1xtyY3uo", quality: 720, mp3: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobId).toMatch(/^[a-z0-9]+$/);

    const filesRes = await fetch(`http://localhost:${s.port}/api/files/${body.jobId}`);
    expect(filesRes.status).toBe(200);
    const filesBody = await filesRes.json();
    expect(Array.isArray(filesBody.files)).toBe(true);
    expect(Array.isArray(filesBody.downloadUrls)).toBe(true);

    await s.close();
  });
});


