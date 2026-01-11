#!/usr/bin/env node
import { createAppServer } from "./server.mjs";
import { parseArgs } from "./cli/args.mjs";

export { parseArgs };

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`youtube

Usage:
  youtube [--port 8787] [--host 0.0.0.0] [--open|--no-open]

Env:
  YTDLP_UI_PORT, YTDLP_UI_HOST, YTDLP_BIN
`);
}

async function openBrowser(url) {
  try {
    const { spawn } = await import("node:child_process");
    const platform = process.platform;
    if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {}
}

const opts = parseArgs(process.argv);
if (opts.help) {
  printHelp();
  process.exit(0);
}

const port = Number(
  opts.port ?? process.env.YTDLP_UI_PORT ?? process.env.PORT ?? 8787,
);
const host = String(
  opts.host ?? process.env.YTDLP_UI_HOST ?? process.env.HOST ?? "127.0.0.1",
);
const shouldOpen = opts.open ?? true;

const { server, close } = createAppServer();

server.listen(port, host, async () => {
  const url = `http://${host}:${port}`;
  // eslint-disable-next-line no-console
  console.log(`youtube running on ${url}`);
  if (shouldOpen) await openBrowser(url);
});

const shutdown = async () => {
  try {
    await close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
