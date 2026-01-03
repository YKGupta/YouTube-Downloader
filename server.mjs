import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveYtDlpBinary(requestedCommand) {
  // If user explicitly sets YTDLP_BIN, trust it.
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;

  // If already a path, keep it.
  if (requestedCommand.includes("/") || requestedCommand.includes("\\"))
    return requestedCommand;

  // Best-effort Windows resolution: Winget installs often aren't visible to Git Bash / npm PATH
  if (process.platform === "win32" && (requestedCommand === "yt-dlp" || requestedCommand === "yt-dlp.exe")) {
    try {
      const out = execFileSync("where.exe", ["yt-dlp"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const first = String(out)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      if (first) return first;
    } catch {
      // ignore
    }

    // Fallback: scan the default Winget packages directory directly
    try {
      const localAppData =
        process.env.LOCALAPPDATA ||
        (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : null);
      if (localAppData) {
        const packagesDir = path.join(localAppData, "Microsoft", "WinGet", "Packages");
        if (fs.existsSync(packagesDir)) {
          const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
          for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            if (!ent.name.toLowerCase().startsWith("yt-dlp.yt-dlp_")) continue;
            const candidate = path.join(packagesDir, ent.name, "yt-dlp.exe");
            if (fs.existsSync(candidate)) return candidate;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return requestedCommand;
}

function json(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res) {
  text(res, 404, "Not found");
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function internalError(res, message) {
  json(res, 500, { error: message });
}

function safeParseJson(body) {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function ensureDirExists(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function getDefaultDownloadsDir() {
  // Best-effort: Chrome default is typically the OS "Downloads" folder.
  // This is local-only tooling; we prefer a sensible default over configurability.
  const home = os.homedir();
  const candidates = [
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "Downloads") : null,
    home ? path.join(home, "Downloads") : null,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (ensureDirExists(p)) return p;
    } catch {
      // ignore
    }
  }
  // fallback to cwd if we cannot find Downloads
  return process.cwd();
}

function safeBasename(name) {
  // Avoid path traversal; also keep it simple for Windows.
  return path.basename(String(name || "")).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
}

function classifyNotAllowedMessage(stderrOrOut) {
  const raw = String(stderrOrOut || "").trim();
  if (!raw) return "Not allowed to download this video by the creator";
  // Keep it friendly; many yt-dlp errors include noisy prefixes.
  const lowered = raw.toLowerCase();
  if (
    lowered.includes("copyright") ||
    lowered.includes("forbidden") ||
    lowered.includes("not available") ||
    lowered.includes("private") ||
    lowered.includes("sign in") ||
    lowered.includes("this video is unavailable")
  ) {
    return "Not allowed to download this video by the creator";
  }
  return "Not allowed to download this video by the creator";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10_000_000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseQuery(urlObj) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of urlObj.searchParams.entries()) out[k] = v;
  return out;
}

function sseHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isValidYtId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function buildVideoUrlFromId(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

function extractQualitiesFromYtDlpInfo(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const heights = new Set();
  for (const f of formats) {
    const h = f?.height;
    if (typeof h === "number" && Number.isFinite(h) && h > 0) heights.add(h);
  }
  return Array.from(heights).sort((a, b) => b - a);
}

function loadPublicIndexHtml() {
  try {
    const candidate = path.join(__dirname, "public", "index.html");
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  } catch {
    // ignore
  }
  return null;
}

function defaultIndexHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>yt-dlp UI (local)</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; }
      .wrap { max-width: 1100px; margin: 0 auto; padding: 18px; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
      label { display: block; font-size: 12px; opacity: 0.8; margin-bottom: 4px; }
      input[type="text"] { width: min(820px, 100%); padding: 10px; border: 1px solid rgba(127,127,127,0.35); border-radius: 10px; }
      button { padding: 10px 12px; border: 1px solid rgba(127,127,127,0.35); border-radius: 10px; background: transparent; cursor: pointer; }
      button.primary { background: #2563eb; color: white; border-color: #2563eb; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      .card { border: 1px solid rgba(127,127,127,0.25); border-radius: 14px; padding: 14px; margin-top: 14px; }
      .muted { opacity: 0.75; font-size: 13px; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      th, td { padding: 8px; border-bottom: 1px solid rgba(127,127,127,0.2); vertical-align: top; }
      th { text-align: left; font-size: 12px; opacity: 0.75; }
      .title { font-weight: 600; }
      .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.35); display: inline-block; }
      .log { height: 260px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; white-space: pre-wrap; background: rgba(127,127,127,0.08); padding: 10px; border-radius: 12px; }
      .split { display: grid; grid-template-columns: 1fr; gap: 12px; }
      @media (min-width: 980px) { .split { grid-template-columns: 2fr 1fr; } }
      a { color: inherit; }
      .sticky-actions { position: sticky; bottom: 0; background: color-mix(in oklab, Canvas 92%, transparent); padding-top: 10px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h2 style="margin: 0 0 6px 0;">yt-dlp Shorts Downloader (local)</h2>
      <div class="muted">Runs <span class="pill">yt-dlp</span> on your machine and streams progress here. Only download videos you own / have rights to.</div>
      <div class="card" id="doctorCard" style="display:none;">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="title">yt-dlp status</div>
            <div class="muted" id="doctorText"></div>
          </div>
          <div class="muted" id="doctorCmd"></div>
        </div>
      </div>

      <div class="card">
        <div class="row">
          <div style="flex: 1 1 680px;">
            <label for="url">Channel / Shorts URL</label>
            <input id="url" type="text" value="https://www.youtube.com/@Grinly2/shorts" />
          </div>
          <div>
            <button id="loadBtn" class="primary">Load videos</button>
          </div>
        </div>
        <div class="row" style="margin-top: 10px;">
          <div style="flex: 1 1 520px;">
            <label for="filter">Filter</label>
            <input id="filter" type="text" placeholder="search titles..." />
          </div>
          <div>
            <button id="selectAllBtn">Select all</button>
            <button id="selectNoneBtn">Select none</button>
          </div>
          <div class="muted" id="count">0 videos</div>
        </div>

        <div style="overflow:auto; margin-top: 8px;">
          <table>
            <thead>
              <tr>
                <th style="width: 36px;"></th>
                <th>Title</th>
                <th style="width: 160px;">Video</th>
              </tr>
            </thead>
            <tbody id="rows"></tbody>
          </table>
        </div>
      </div>

      <div class="split">
        <div class="card">
          <div class="row">
            <div style="flex: 1 1 680px;">
              <label for="outDir">Download folder path (server-side)</label>
              <input id="outDir" type="text" placeholder="e.g. C:\\\\Users\\\\You\\\\Downloads\\\\Grinly2" />
              <div class="muted" style="margin-top: 6px;">Tip: create the folder first; this tool won’t create it automatically.</div>
            </div>
          </div>
          <div class="row" style="margin-top: 10px;">
            <div>
              <label><input id="useCookies" type="checkbox" /> Use cookies from browser (for private/unlisted)</label>
              <div class="row" style="margin-top: 6px;">
                <select id="browser" style="padding: 10px; border-radius: 10px; border: 1px solid rgba(127,127,127,0.35);">
                  <option value="chrome">chrome</option>
                  <option value="edge">edge</option>
                  <option value="firefox">firefox</option>
                </select>
              </div>
            </div>
            <div class="sticky-actions" style="margin-left:auto;">
              <button id="downloadBtn" class="primary" disabled>Download selected</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="row" style="justify-content: space-between;">
            <div>
              <div class="title">Progress</div>
              <div class="muted" id="status">Idle</div>
            </div>
            <div>
              <button id="clearLogBtn">Clear log</button>
            </div>
          </div>
          <div class="log" id="log"></div>
        </div>
      </div>
    </div>

    <script>
      const el = (id) => document.getElementById(id);
      const state = {
        videos: [],
        selected: new Set(),
        jobId: localStorage.getItem("ytdlp_jobId") || "",
        evt: null,
      };

      function log(line) {
        const box = el("log");
        box.textContent += line + "\\n";
        box.scrollTop = box.scrollHeight;
      }

      function setStatus(s) {
        el("status").textContent = s;
      }

      function render() {
        const filter = el("filter").value.toLowerCase().trim();
        const rows = el("rows");
        rows.innerHTML = "";
        let shown = 0;
        for (const v of state.videos) {
          if (filter && !(v.title || "").toLowerCase().includes(filter) && !(v.id || "").includes(filter)) continue;
          shown++;
          const tr = document.createElement("tr");
          const checked = state.selected.has(v.id);
          tr.innerHTML = \`
            <td><input type="checkbox" \${checked ? "checked" : ""} data-id="\${v.id}" /></td>
            <td>
              <div class="title">\${escapeHtml(v.title || "(no title)")}</div>
              <div class="muted">\${escapeHtml(v.id)}</div>
            </td>
            <td><a href="\${v.url}" target="_blank" rel="noreferrer">open</a></td>
          \`;
          rows.appendChild(tr);
        }
        el("count").textContent = \`\${shown} shown • \${state.videos.length} total • \${state.selected.size} selected\`;
        el("downloadBtn").disabled = state.selected.size === 0;
      }

      function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;" }[c]));
      }

      async function apiGet(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
      }

      async function apiPost(url, body) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
      }

      async function loadVideos() {
        setStatus("Loading list…");
        const url = el("url").value.trim();
        const data = await apiGet(\`/api/list?url=\${encodeURIComponent(url)}\`);
        state.videos = data.videos || [];
        state.selected = new Set();
        setStatus(\`Loaded \${state.videos.length} videos\`);
        log(\`[list] loaded \${state.videos.length} items\`);
        render();
      }

      function connectSse(jobId) {
        if (!jobId) return;
        if (state.evt) state.evt.close();
        setStatus(\`Downloading… (job \${jobId})\`);
        const evt = new EventSource(\`/api/events/\${encodeURIComponent(jobId)}\`);
        state.evt = evt;
        evt.addEventListener("log", (e) => {
          try { log(JSON.parse(e.data).line); } catch { log(String(e.data)); }
        });
        evt.addEventListener("done", (e) => {
          const payload = JSON.parse(e.data);
          log(\`[done] exitCode=\${payload.exitCode}\`);
          setStatus(payload.exitCode === 0 ? "Done" : "Done (with errors)");
          localStorage.removeItem("ytdlp_jobId");
          state.jobId = "";
          evt.close();
        });
        evt.addEventListener("error", () => {
          log("[sse] disconnected");
          setStatus("Disconnected (refresh to reconnect if job still running)");
        });
      }

      async function startDownload() {
        const url = el("url").value.trim();
        const outDir = el("outDir").value.trim();
        const ids = Array.from(state.selected);
        const useCookies = el("useCookies").checked;
        const browser = el("browser").value;
        if (!outDir) { alert("Please enter a download folder path"); return; }
        setStatus("Starting download…");
        const resp = await apiPost("/api/download", { url, ids, outDir, cookiesFromBrowser: useCookies ? browser : null });
        const jobId = resp.jobId;
        localStorage.setItem("ytdlp_jobId", jobId);
        state.jobId = jobId;
        log(\`[start] jobId=\${jobId} items=\${ids.length}\`);
        connectSse(jobId);
      }

      el("loadBtn").addEventListener("click", () => loadVideos().catch((e) => { setStatus("Error"); alert(e.message); }));
      el("filter").addEventListener("input", () => render());
      el("rows").addEventListener("change", (e) => {
        const t = e.target;
        if (t && t.matches("input[type=checkbox][data-id]")) {
          const id = t.getAttribute("data-id");
          if (t.checked) state.selected.add(id); else state.selected.delete(id);
          render();
        }
      });
      el("selectAllBtn").addEventListener("click", () => { state.selected = new Set(state.videos.map(v => v.id)); render(); });
      el("selectNoneBtn").addEventListener("click", () => { state.selected = new Set(); render(); });
      el("downloadBtn").addEventListener("click", () => startDownload().catch((e) => { setStatus("Error"); alert(e.message); }));
      el("clearLogBtn").addEventListener("click", () => { el("log").textContent = ""; });

      // auto-reconnect if a job is still stored
      if (state.jobId) {
        log(\`[resume] reconnecting to job \${state.jobId}\`);
        connectSse(state.jobId);
      }

      // show yt-dlp diagnostics
      (async () => {
        try {
          const d = await apiGet("/api/doctor");
          const card = el("doctorCard");
          card.style.display = "block";
          el("doctorCmd").textContent = d.ytDlpCommand ? \`bin: \${d.ytDlpCommand}\` : "";
          if (d.ok) {
            el("doctorText").textContent = d.message || "OK";
          } else {
            el("doctorText").textContent =
              (d.message || "yt-dlp not available") +
              " — install yt-dlp (e.g. winget install yt-dlp.yt-dlp) or set YTDLP_BIN to full path to yt-dlp.exe.";
          }
        } catch (e) {
          // ignore
        }
      })();
    </script>
  </body>
</html>`;
}

/**
 * @typedef {(args: string[], opts: { cwd?: string }) => import("node:child_process").ChildProcessWithoutNullStreams} YtDlpSpawner
 */

export function createAppServer({
  ytDlpCommand = resolveYtDlpBinary("yt-dlp"),
  spawnYtDlp = (args, opts) => spawn(ytDlpCommand, args, { ...opts }),
  indexHtml = loadPublicIndexHtml() || defaultIndexHtml(),
  downloadsBaseDir = null,
} = {}) {
  /** @type {Map<string, { id: string, createdAt: number, lines: string[], sseClients: Set<import("node:http").ServerResponse>, done?: { exitCode: number | null } }>} */
  const jobs = new Map();

  function jobAppend(jobId, line) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.lines.push(line);
    if (job.lines.length > 2000) job.lines.splice(0, job.lines.length - 2000);
    for (const client of job.sseClients) {
      sseSend(client, "log", { line });
    }
  }

  function jobDone(jobId, exitCode) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.done = { exitCode };
    for (const client of job.sseClients) {
      sseSend(client, "done", { exitCode });
      client.end();
    }
    job.sseClients.clear();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const { pathname } = urlObj;

      if (req.method === "GET" && pathname === "/") {
        return text(res, 200, indexHtml, "text/html; charset=utf-8");
      }

      if (req.method === "GET" && pathname === "/health") {
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/api/doctor") {
        // quick sanity check whether yt-dlp is runnable from this process
        try {
          const child = spawnYtDlp(["--version"], { cwd: process.cwd() });
          let out = "";
          let err = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          const result = await new Promise((resolve) => {
            child.on("close", (code) => resolve({ code }));
            child.on("error", (e) => resolve({ error: e }));
          });

          if (result.error) {
            return json(res, 200, {
              ok: false,
              ytDlpCommand,
              message: `Cannot spawn yt-dlp: ${result.error?.code || ""} ${result.error?.message || ""}`.trim(),
            });
          }

          if (result.code !== 0) {
            return json(res, 200, {
              ok: false,
              ytDlpCommand,
              message: `yt-dlp exited ${result.code}. ${String(err || out).trim()}`.trim(),
            });
          }

          return json(res, 200, {
            ok: true,
            ytDlpCommand,
            message: `yt-dlp ${String(out).trim()}`.trim(),
          });
        } catch (e) {
          return json(res, 200, {
            ok: false,
            ytDlpCommand,
            message: `Failed to start yt-dlp: ${e?.message || "unknown error"}`.trim(),
          });
        }
      }

      if (req.method === "GET" && pathname === "/api/info") {
        const q = parseQuery(urlObj);
        const url = (q.url || "").trim();
        if (!url) return badRequest(res, "Missing url");

        let child;
        try {
          child = spawnYtDlp(["-J", "--no-warnings", "--yes-playlist", url], { cwd: process.cwd() });
        } catch (e) {
          return internalError(
            res,
            `Failed to start yt-dlp (${ytDlpCommand}). Set YTDLP_BIN to the full path to yt-dlp.exe. ${e?.message || ""}`.trim(),
          );
        }

        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));

        const exitCode = await new Promise((resolve) => {
          child.on("close", resolve);
          child.on("error", (err) => resolve({ __error: err }));
        });

        if (exitCode && typeof exitCode === "object" && exitCode.__error) {
          const err = exitCode.__error;
          return json(res, 200, {
            ok: false,
            message: classifyNotAllowedMessage(`${err?.code || ""} ${err?.message || ""}`.trim()),
          });
        }

        if (exitCode !== 0) {
          return json(res, 200, {
            ok: false,
            message: classifyNotAllowedMessage(stderr || stdout),
          });
        }

        const parsed = safeParseJson(stdout.trim());
        if (!parsed.ok) {
          return json(res, 200, { ok: false, message: "Could not read video info" });
        }
        const info = parsed.value;
        const title = String(info?.title || "");
        const id = String(info?.id || "");
        const qualities = extractQualitiesFromYtDlpInfo(info);

        return json(res, 200, {
          ok: true,
          title,
          id,
          qualities,
          mp3: true,
        });
      }

      if (req.method === "GET" && pathname === "/api/list") {
        const q = parseQuery(urlObj);
        const url = (q.url || "").trim();
        if (!url) return badRequest(res, "Missing url");

        /** @type {{ id: string, title: string, url: string }[]} */
        const videos = [];

        let child;
        try {
          child = spawnYtDlp(["--flat-playlist", "--dump-json", "--yes-playlist", url], {
            cwd: process.cwd(),
          });
        } catch (e) {
          return internalError(
            res,
            `Failed to start yt-dlp (${ytDlpCommand}). Set YTDLP_BIN to the full path to yt-dlp.exe. ${e?.message || ""}`.trim(),
          );
        }

        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (d) => {
          stderr += d;
        });

        child.stdout.setEncoding("utf8");
        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parsed = safeParseJson(trimmed);
            if (!parsed.ok) continue;
            const obj = parsed.value;
            const id = obj?.id;
            const title = obj?.title;
            if (!isValidYtId(id)) continue;
            videos.push({ id, title: String(title || ""), url: buildVideoUrlFromId(id) });
          }
        });

        const exitCode = await new Promise((resolve) => {
          child.on("close", resolve);
          child.on("error", (err) => resolve({ __error: err }));
        });
        if (exitCode && typeof exitCode === "object" && exitCode.__error) {
          const err = exitCode.__error;
          return internalError(
            res,
            `Failed to run yt-dlp (${ytDlpCommand}): ${err?.code || ""} ${err?.message || ""}. Set YTDLP_BIN to the full path to yt-dlp.exe.`.trim(),
          );
        }
        if (exitCode !== 0) {
          return internalError(res, `yt-dlp failed (exit ${exitCode}). ${stderr.trim()}`.trim());
        }
        return json(res, 200, { videos });
      }

      if (req.method === "GET" && pathname === "/api/playlist") {
        // Alias of /api/list (kept for backwards compatibility); intended for playlist selection UI.
        const q = parseQuery(urlObj);
        const url = (q.url || "").trim();
        if (!url) return badRequest(res, "Missing url");

        /** @type {{ id: string, title: string, url: string }[]} */
        const videos = [];

        let child;
        try {
          child = spawnYtDlp(["--flat-playlist", "--dump-json", "--yes-playlist", url], {
            cwd: process.cwd(),
          });
        } catch (e) {
          return internalError(
            res,
            `Failed to start yt-dlp (${ytDlpCommand}). Set YTDLP_BIN to the full path to yt-dlp.exe. ${e?.message || ""}`.trim(),
          );
        }

        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (d) => {
          stderr += d;
        });

        child.stdout.setEncoding("utf8");
        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parsed = safeParseJson(trimmed);
            if (!parsed.ok) continue;
            const obj = parsed.value;
            const id = obj?.id;
            const title = obj?.title;
            if (!isValidYtId(id)) continue;
            videos.push({ id, title: String(title || ""), url: buildVideoUrlFromId(id) });
          }
        });

        const exitCode = await new Promise((resolve) => {
          child.on("close", resolve);
          child.on("error", (err) => resolve({ __error: err }));
        });
        if (exitCode && typeof exitCode === "object" && exitCode.__error) {
          const err = exitCode.__error;
          return internalError(
            res,
            `Failed to run yt-dlp (${ytDlpCommand}): ${err?.code || ""} ${err?.message || ""}. Set YTDLP_BIN to the full path to yt-dlp.exe.`.trim(),
          );
        }
        if (exitCode !== 0) {
          return internalError(res, `yt-dlp failed (exit ${exitCode}). ${stderr.trim()}`.trim());
        }
        return json(res, 200, { videos });
      }

      if (req.method === "POST" && pathname === "/api/download") {
        const raw = await readBody(req);
        const parsed = safeParseJson(raw);
        if (!parsed.ok) return badRequest(res, "Invalid JSON body");

        const body = parsed.value || {};
        const ids = Array.isArray(body.ids) ? body.ids : [];
        const url = String(body.url || "").trim();
        const requestedQuality = body.quality === null || body.quality === undefined ? null : Number(body.quality);
        const mp3 = Boolean(body.mp3);
        const cookiesFromBrowser = body.cookiesFromBrowser ? String(body.cookiesFromBrowser) : null;

        const validIds = ids.filter(isValidYtId);
        const isBulk = validIds.length > 0;
        if (!isBulk && !url) return badRequest(res, "Missing url");

        const jobId = crypto.randomBytes(8).toString("hex");
        const job = {
          id: jobId,
          createdAt: Date.now(),
          lines: [],
          sseClients: new Set(),
          downloadsDir: null,
        };
        jobs.set(jobId, job);

        const baseDownloadsDir = downloadsBaseDir || getDefaultDownloadsDir();
        const jobDir = path.join(baseDownloadsDir, "ytdlp-ui", jobId);
        try {
          fs.mkdirSync(jobDir, { recursive: true });
        } catch {
          // ignore
        }
        job.downloadsDir = jobDir;

        const archivePath = path.join(baseDownloadsDir, "ytdlp-ui", ".ytdlp-archive.txt");
        const outputTemplate = "%(upload_date)s - %(title)s [%(id)s].%(ext)s";

        /** @type {string[]} */
        const args = [
          "-i",
          "--yes-playlist",
          "--newline",
          "--no-warnings",
          "--download-archive",
          archivePath,
          "-P",
          jobDir,
          "-o",
          outputTemplate,
        ];

        if (mp3) {
          args.push("--extract-audio", "--audio-format", "mp3");
        } else {
          args.push("--merge-output-format", "mp4");
        }

        if (requestedQuality && Number.isFinite(requestedQuality)) {
          const h = Math.floor(requestedQuality);
          // Best-effort format selector that caps height.
          args.push("-f", `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`);
        }

        let tmpListPath = null;
        if (isBulk) {
          tmpListPath = path.join(os.tmpdir(), `ytdlp-ui-${jobId}.txt`);
          const urlsList = validIds.map(buildVideoUrlFromId).join("\n") + "\n";
          fs.writeFileSync(tmpListPath, urlsList, "utf8");
          args.push("-a", tmpListPath);
        } else {
          args.push(url);
        }

        if (cookiesFromBrowser) {
          if (!["chrome", "edge", "firefox"].includes(cookiesFromBrowser)) {
            return badRequest(res, "cookiesFromBrowser must be one of: chrome, edge, firefox");
          }
          args.unshift("--cookies-from-browser", cookiesFromBrowser);
        }

        let child;
        try {
          child = spawnYtDlp(args, { cwd: process.cwd() });
        } catch (e) {
          if (tmpListPath) {
            try {
              fs.unlinkSync(tmpListPath);
            } catch {}
          }
          jobAppend(jobId, `Failed to start yt-dlp (${ytDlpCommand}). Set YTDLP_BIN to full path. ${e?.message || ""}`.trim());
          jobDone(jobId, -1);
          return json(res, 200, { jobId, count: isBulk ? validIds.length : 1 });
        }

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        const onData = (chunk) => {
          const lines = String(chunk).split(/\r?\n/).filter(Boolean);
          for (const line of lines) jobAppend(jobId, line);
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);

        child.on("error", (err) => {
          if (tmpListPath) {
            try {
              fs.unlinkSync(tmpListPath);
            } catch {}
          }
          jobAppend(jobId, `yt-dlp spawn error: ${err?.code || ""} ${err?.message || ""}`.trim());
          jobDone(jobId, -1);
        });

        child.on("close", (code) => {
          if (tmpListPath) {
            try {
              fs.unlinkSync(tmpListPath);
            } catch {}
          }
          jobDone(jobId, typeof code === "number" ? code : -1);
        });

        return json(res, 200, { jobId, count: isBulk ? validIds.length : 1, downloadsDir: jobDir });
      }

      const filesMatch = pathname.match(/^\/api\/files\/([a-z0-9]+)$/);
      if (req.method === "GET" && filesMatch) {
        const jobId = filesMatch[1];
        const job = jobs.get(jobId);
        if (!job) return badRequest(res, "Unknown jobId");
        const dir = job.downloadsDir;
        if (!dir) return json(res, 200, { files: [] });
        let files = [];
        try {
          files = fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isFile())
            .map((d) => d.name);
        } catch {
          files = [];
        }
        return json(res, 200, {
          files,
          downloadUrls: files.map((f) => `/api/file/${jobId}/${encodeURIComponent(f)}`),
        });
      }

      const fileMatch = pathname.match(/^\/api\/file\/([a-z0-9]+)\/(.+)$/);
      if (req.method === "GET" && fileMatch) {
        const jobId = fileMatch[1];
        const rawName = decodeURIComponent(fileMatch[2] || "");
        const fileName = safeBasename(rawName);
        const job = jobs.get(jobId);
        if (!job) return badRequest(res, "Unknown jobId");
        const dir = job.downloadsDir;
        if (!dir) return badRequest(res, "No downloads for job");
        const fullPath = path.join(dir, fileName);
        if (!fs.existsSync(fullPath)) return notFound(res);

        const stat = fs.statSync(fullPath);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": stat.size,
          "content-disposition": `attachment; filename="${safeBasename(fileName)}"`,
          "cache-control": "no-store",
        });
        fs.createReadStream(fullPath).pipe(res);
        return;
      }

      const eventsMatch = pathname.match(/^\/api\/events\/([a-z0-9]+)$/);
      if (req.method === "GET" && eventsMatch) {
        const jobId = eventsMatch[1];
        const job = jobs.get(jobId);
        if (!job) return badRequest(res, "Unknown jobId");

        sseHeaders(res);
        // replay tail
        for (const line of job.lines.slice(-250)) sseSend(res, "log", { line });
        if (job.done) {
          sseSend(res, "done", { exitCode: job.done.exitCode });
          return res.end();
        }
        job.sseClients.add(res);
        req.on("close", () => job.sseClients.delete(res));
        return;
      }

      return notFound(res);
    } catch (e) {
      return internalError(res, e?.message || "Unexpected error");
    }
  });

  return {
    server,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

// Run directly: `node tools/ytdlp-ui/server.mjs`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.YTDLP_UI_PORT || process.env.PORT || 8787);
  const host = String(process.env.YTDLP_UI_HOST || process.env.HOST || "0.0.0.0");
  const { server } = createAppServer();
  let currentPort = port;
  let attemptsLeft = 15;

  const tryListen = () => {
    server.listen(currentPort, host, () => {
      // eslint-disable-next-line no-console
      console.log(`yt-dlp UI running on http://${host}:${currentPort}`);
    });
  };

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE" && attemptsLeft > 0) {
      attemptsLeft -= 1;
      currentPort += 1;
      // eslint-disable-next-line no-console
      console.log(
        `Port ${currentPort - 1} is in use, trying http://localhost:${currentPort} ...`,
      );
      tryListen();
      return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });

  tryListen();
}


