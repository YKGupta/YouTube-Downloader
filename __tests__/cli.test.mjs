// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseArgs } from "../cli/args.mjs";

describe("ytdlp-ui CLI", () => {
  it("parses --help", () => {
    expect(parseArgs(["node", "cli.mjs", "--help"])).toEqual({ help: true });
    expect(parseArgs(["node", "cli.mjs", "-h"])).toEqual({ help: true });
  });

  it("parses host/port forms", () => {
    expect(parseArgs(["node", "cli.mjs", "--host", "0.0.0.0", "--port", "9999"])).toEqual({
      host: "0.0.0.0",
      port: 9999,
    });
    expect(parseArgs(["node", "cli.mjs", "--host=127.0.0.1", "--port=8787"])).toEqual({
      host: "127.0.0.1",
      port: 8787,
    });
  });

  it("parses --open/--no-open", () => {
    expect(parseArgs(["node", "cli.mjs", "--open"])).toEqual({ open: true });
    expect(parseArgs(["node", "cli.mjs", "--no-open"])).toEqual({ open: false });
  });
});


