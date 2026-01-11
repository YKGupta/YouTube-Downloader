// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_TIMEOUT = 20_000;

async function listen(app, port = 0, host = "127.0.0.1") {
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  app.server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    app.server.once("error", onError);
    app.server.listen(port, host, () => {
      app.server.off("error", onError);
      resolve();
    });
  });

  const addr = app.server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Server did not provide a TCP address");
  }

  const url = `http://${host}:${addr.port}`;
  return {
    port: addr.port,
    url,
    close: async () => {
      // Ensure keep-alive sockets don't cause server.close() to hang in CI.
      for (const s of sockets) s.destroy();
      if (typeof app.server.closeAllConnections === "function") {
        app.server.closeAllConnections();
      }
      if (typeof app.server.closeIdleConnections === "function") {
        app.server.closeIdleConnections();
      }
      await app.close();
    },
  };
}

function makeFakeSpawner({
  infoJson = null,
  listLines = [],
  downloadLines = [],
  exitCode = 0,
} = {}) {
  return (args, _opts) => {
    // Minimal ChildProcessWithoutNullStreams mock
    /** @type {any} */
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();

    const isInfo = args.includes("-J");
    const isList =
      args.includes("--flat-playlist") && args.includes("--dump-json");
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

function makeRecordingSpawner() {
  /** @type {string[][]} */
  const calls = [];
  const spawner = (args, _opts) => {
    calls.push(args);
    return makeFakeSpawner()(args, _opts);
  };
  return { spawner, calls };
}

function makeErrorSpawner({
  code = "ENOENT",
  message = "spawn yt-dlp ENOENT",
} = {}) {
  return (_args, _opts) => {
    /** @type {any} */
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();

    queueMicrotask(() => {
      const err = /** @type {any} */ (new Error(message));
      err.code = code;
      child.emit("error", err);
    });

    return child;
  };
}

describe("ytdlp-ui server", () => {
  it(
    "GET /api/doctor returns ok=false when yt-dlp cannot be spawned",
    async () => {
      const { createAppServer } = await import("../server.mjs");
      const app = createAppServer({ spawnYtDlp: makeErrorSpawner() });
      const s = await listen(app);

      const res = await fetch(`${s.url}/api/doctor`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.message).toMatch(/cannot spawn yt-dlp/i);

      await s.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "GET /api/info returns ok=true and qualities for a video",
    async () => {
      const { createAppServer } = await import("../server.mjs");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-ui-test-"));
      const fakeSpawn = makeFakeSpawner({
        infoJson: {
          id: "f4g1xtyY3uo",
          title: "My Video",
          formats: [{ height: 720 }, { height: 360 }, { height: null }],
        },
      });
      const app = createAppServer({
        spawnYtDlp: fakeSpawn,
        downloadsBaseDir: tmp,
      });
      const s = await listen(app);

      const res = await fetch(
        `${s.url}/api/info?url=${encodeURIComponent("https://example.com")}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.title).toBe("My Video");
      expect(body.qualities).toEqual([720, 360]);
      expect(body.mp3).toBe(true);

      await s.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "GET /api/list returns parsed videos",
    async () => {
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

      const res = await fetch(
        `${s.url}/api/list?url=${encodeURIComponent("https://example.com")}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.videos).toEqual([
        {
          id: "f4g1xtyY3uo",
          title: "Short 1",
          url: "https://www.youtube.com/watch?v=f4g1xtyY3uo",
        },
        {
          id: "gAnS4WTgeIE",
          title: "Short 2",
          url: "https://www.youtube.com/watch?v=gAnS4WTgeIE",
        },
      ]);

      await s.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "GET /api/list returns 500 when yt-dlp cannot be spawned",
    async () => {
      const { createAppServer } = await import("../server.mjs");
      const app = createAppServer({ spawnYtDlp: makeErrorSpawner() });
      const s = await listen(app);

      const res = await fetch(
        `${s.url}/api/list?url=${encodeURIComponent("https://example.com")}`,
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/set ytdlp_bin/i);

      await s.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "POST /api/download requires either url or ids",
    async () => {
      const { createAppServer } = await import("../server.mjs");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-ui-test-"));
      const app = createAppServer({
        spawnYtDlp: makeFakeSpawner(),
        downloadsBaseDir: tmp,
      });
      const s = await listen(app);

      const res = await fetch(`${s.url}/api/download`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/missing url/i);

      await s.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "POST /api/download starts a job for a single url and exposes /api/files/:jobId",
    async () => {
      const { createAppServer } = await import("../server.mjs");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-ui-test-"));
      const app = createAppServer({
        spawnYtDlp: makeFakeSpawner(),
        downloadsBaseDir: tmp,
      });
      const s = await listen(app);

      const res = await fetch(`${s.url}/api/download`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/watch?v=f4g1xtyY3uo",
          quality: 720,
          mp3: false,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobId).toMatch(/^[a-z0-9]+$/);

      const filesRes = await fetch(`${s.url}/api/files/${body.jobId}`);
      expect(filesRes.status).toBe(200);
      const filesBody = await filesRes.json();
      expect(Array.isArray(filesBody.files)).toBe(true);
      expect(Array.isArray(filesBody.downloadUrls)).toBe(true);

      await s.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "POST /api/download with videoOnly uses bestvideo and remuxes to mp4",
    async () => {
      const { createAppServer } = await import("../server.mjs");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-ui-test-"));
      const rec = makeRecordingSpawner();
      const app = createAppServer({
        spawnYtDlp: rec.spawner,
        downloadsBaseDir: tmp,
      });
      const s = await listen(app);

      const res = await fetch(`${s.url}/api/download`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/watch?v=f4g1xtyY3uo",
          quality: 720,
          mp3: false,
          videoOnly: true,
        }),
      });
      expect(res.status).toBe(200);

      const downloadCall = rec.calls.find((a) => a.includes("--newline"));
      expect(downloadCall).toBeTruthy();
      expect(downloadCall).toContain("--remux-video");
      expect(downloadCall).toContain("mp4");
      expect(downloadCall).toContain("-f");
      expect(downloadCall.join(" ")).toMatch(/bestvideo\[height<=720\]/);
      expect(downloadCall.join(" ")).not.toMatch(/\+bestaudio/);

      await s.close();
    },
    TEST_TIMEOUT,
  );
});
