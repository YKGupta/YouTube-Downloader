export function parseArgs(argv) {
  const args = argv.slice(2);
  /** @type {{ host?: string, port?: number, open?: boolean, help?: boolean }} */
  const out = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--no-open") out.open = false;
    else if (a === "--open") out.open = true;
    else if (a === "--host") out.host = args[++i];
    else if (a.startsWith("--host=")) out.host = a.slice("--host=".length);
    else if (a === "--port") out.port = Number(args[++i]);
    else if (a.startsWith("--port=")) out.port = Number(a.slice("--port=".length));
  }

  if (Number.isNaN(out.port)) out.port = undefined;
  return out;
}


