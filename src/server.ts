#!/usr/bin/env node
import { RelayClient } from "./relay-client.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18792;
const DEFAULT_TOKEN = "aionda-browser-dev";
const DEFAULT_TIMEOUT_MS = 10000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ExtensionState = {
  tabId?: number;
  url?: string;
  title?: string;
  attached?: boolean;
  version?: string;
  error?: string;
};

type ServerOptions = {
  host: string;
  port: number;
  token: string;
  timeoutMs: number;
};

const options = parseOptions(process.argv.slice(2));
const relay = new RelayClient(options);
const sendCommand = (command: string, payload: JsonValue, timeoutMs = options.timeoutMs) =>
  relay.request(command, payload, timeoutMs);

const browserServer = new McpServer({
  name: "aionda-browser-mcp",
  version: "0.3.1",
});

browserServer.tool("browser_status", "Return relay and attached-tab status.", {}, async () => {
  return textResult(await relay.request("status", {}, options.timeoutMs));
});

browserServer.tool("browser_tab", "Return the currently attached browser tab.", {}, async () => {
  const status = await relay.request("status", {}, options.timeoutMs) as { relay: { connected: boolean }; tab: ExtensionState };
  if (!status.relay.connected) return errorResult("Chrome extension is not connected to the relay.");
  return textResult(status.tab);
});

browserServer.tool(
  "browser_attach",
  "Select a Chrome tab for this MCP session, independent of other clients. Provide tabId from browser_list_tabs or urlContains.",
  { urlContains: z.string().optional(), tabId: z.number().int().positive().optional(), followActive: z.boolean().optional() },
  async ({ urlContains, tabId, followActive }) => textResult(await sendCommand("attach", compactPayload({ urlContains, tabId, followActive }), 5000))
);

browserServer.tool(
  "browser_open_tab",
  "Open a URL in a new tab (or window) and attach it to this MCP session.",
  { url: z.string().url(), newWindow: z.boolean().optional(), active: z.boolean().optional() },
  async ({ url, newWindow, active }) => textResult(await sendCommand("openTab", compactPayload({ url, newWindow, active }), 5000))
);

browserServer.tool("browser_list_tabs", "List normal Chrome tabs visible to the extension.", {}, async () => {
  return textResult(await sendCommand("listTabs", {}, 5000));
});

browserServer.tool(
  "browser_snapshot",
  "Get a text and element snapshot from the attached tab. Use element refs with click/type tools.",
  {},
  async () => textResult(await sendCommand("snapshot", {}))
);

browserServer.tool(
  "browser_snapshot_compact",
  "Get a token-light snapshot of visible interactive elements. Use query to filter by visible text.",
  {
    query: z.string().optional(),
    textLimit: z.number().int().min(0).max(12000).optional(),
    elementLimit: z.number().int().min(1).max(500).optional(),
    nameLimit: z.number().int().min(16).max(500).optional(),
    includeBounds: z.boolean().optional(),
  },
  async ({ query, textLimit, elementLimit, nameLimit, includeBounds }) =>
    textResult(await sendCommand("snapshotCompact", compactPayload({ query, textLimit, elementLimit, nameLimit, includeBounds })))
);

browserServer.tool(
  "browser_click",
  "Click an element ref from browser_snapshot.",
  { ref: z.string(), button: z.enum(["left", "middle", "right"]).optional() },
  async ({ ref, button }) => textResult(await sendCommand("click", { ref, button: button ?? "left" }))
);

browserServer.tool(
  "browser_click_at",
  "Click viewport coordinates in the attached tab. Use when the page renders visible controls that are missing from snapshots.",
  { x: z.number(), y: z.number(), button: z.enum(["left", "middle", "right"]).optional() },
  async ({ x, y, button }) => textResult(await sendCommand("clickAt", { x, y, button: button ?? "left" }))
);

browserServer.tool("browser_extension_reload", "Reload the Chrome extension and let it reconnect to the relay.", {}, async () => {
  const result = await sendCommand("reloadExtension", {}, 2000);
  return textResult(result);
});

browserServer.tool(
  "browser_type",
  "Type text into an element ref from browser_snapshot.",
  { ref: z.string(), text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional() },
  async ({ ref, text, clear, submit }) => textResult(await sendCommand("type", { ref, text, clear: clear === true, submit: submit === true }))
);

browserServer.tool(
  "browser_press_key",
  "Press a key or key chord in the attached tab, for example Enter, Escape, Tab, ArrowDown, or Mod+l.",
  { key: z.string() },
  async ({ key }) => textResult(await sendCommand("pressKey", { key }))
);

browserServer.tool(
  "browser_navigate",
  "Navigate the attached tab to a URL.",
  { url: z.string().url() },
  async ({ url }) => textResult(await sendCommand("navigate", { url }, 20000))
);

browserServer.tool(
  "browser_screenshot",
  "Capture the visible viewport of the attached tab as a PNG data URL.",
  {},
  async () => textResult(await sendCommand("screenshot", {}, 20000))
);

browserServer.tool(
  "browser_screenshot_fast",
  "Capture a small screenshot of the attached tab for quick visual parsing. Defaults to a 960px-wide JPEG.",
  {
    maxWidth: z.number().int().min(320).max(1920).optional(),
    maxHeight: z.number().int().min(0).max(2160).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    format: z.enum(["jpeg", "png"]).optional(),
    grayscale: z.boolean().optional(),
    maxBytes: z.number().int().min(0).max(2000000).optional(),
  },
  async ({ maxWidth, maxHeight, quality, format, grayscale, maxBytes }) =>
    imageResult(await sendCommand("screenshotFast", compactPayload({ maxWidth, maxHeight, quality, format, grayscale, maxBytes }), 20000))
);

browserServer.tool(
  "browser_evaluate",
  "Evaluate JavaScript in an isolated page world through the Debugger API. Use only for trusted pages.",
  { code: z.string() },
  async ({ code }) => textResult(await sendCommand("evaluate", { code }))
);

browserServer.tool(
  "browser_scroll",
  "Scroll the attached tab natively (CSP-safe, no eval). direction up/down scrolls one viewport (or amount pixels); top/bottom jumps to the page start/end. Defaults to down.",
  {
    direction: z.enum(["up", "down", "top", "bottom"]).optional(),
    amount: z.number().int().min(1).max(100000).optional(),
  },
  async ({ direction, amount }) => textResult(await sendCommand("scroll", compactPayload({ direction, amount })))
);

browserServer.tool(
  "browser_scroll_into_view",
  "Scroll an element ref from browser_snapshot into the center of the viewport (CSP-safe, no eval).",
  { ref: z.string() },
  async ({ ref }) => textResult(await sendCommand("scrollIntoView", { ref }))
);

browserServer.tool(
  "browser_upload_file",
  "Upload local file(s) into a file input on the attached tab via CDP (DOM.setFileInputFiles), bypassing the OS file picker. Paths must be absolute and exist on the machine running Chrome. By default targets the first input[type=file]; pass selector or ref to target a specific input. Only works for inputs in the main frame.",
  {
    paths: z.array(z.string()).min(1),
    selector: z.string().optional(),
    ref: z.string().optional(),
  },
  async ({ paths, selector, ref }) =>
    textResult(await sendCommand("uploadFiles", compactPayload({ files: paths, selector, ref }), 20000))
);

async function main() {
  const transport = new StdioServerTransport();
  await browserServer.connect(transport);
  const shutdown = () => { relay.close(); process.exit(0); };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  const parentPid = process.ppid;
  setInterval(() => { if (process.ppid !== parentPid) shutdown(); }, 5000).unref();
}

function textResult(value: JsonValue | ExtensionState) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function imageResult(value: JsonValue) {
  if (!isRecord(value) || typeof value.dataUrl !== "string") return textResult(value);

  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value.dataUrl);
  if (!match) return textResult(value);

  const { dataUrl: _dataUrl, ...metadata } = value;
  return {
    content: [
      { type: "image" as const, data: match[2], mimeType: match[1] },
      { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
    ],
  };
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactPayload(payload: Record<string, JsonValue | undefined>): JsonValue {
  const result: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function parseOptions(args: string[]): ServerOptions {
  const port = Number(readFlag(args, "--port") ?? process.env.AIONDA_BROWSER_PORT ?? DEFAULT_PORT);
  return {
    host: readFlag(args, "--host") ?? process.env.AIONDA_BROWSER_HOST ?? DEFAULT_HOST,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    token: readFlag(args, "--token") ?? process.env.AIONDA_BROWSER_TOKEN ?? DEFAULT_TOKEN,
    timeoutMs: Number(readFlag(args, "--timeout-ms") ?? process.env.AIONDA_BROWSER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
}

function readFlag(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

main().catch((error) => {
  console.error("aionda-browser-mcp failed:", error);
  process.exit(1);
});
