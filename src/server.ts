#!/usr/bin/env node
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18792;
const DEFAULT_PORT_COUNT = 128;
const MAX_PORT_COUNT = 1024;
const DEFAULT_TOKEN = "aionda-browser-dev";
const DEFAULT_TIMEOUT_MS = 10000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ExtensionState = {
  tabId?: number;
  url?: string;
  title?: string;
  attached?: boolean;
  followsActiveTab?: boolean;
  version?: string;
  error?: string;
};

type RelayResponse =
  | { ok: true; result: JsonValue }
  | { ok: false; error: string };

type PendingRequest = {
  resolve: (value: JsonValue) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

type ServerOptions = {
  host: string;
  port: number;
  portCount: number;
  token: string;
  timeoutMs: number;
};

const options = parseOptions(process.argv.slice(2));
const pendingRequests = new Map<string, PendingRequest>();
let extensionSocket: WebSocket | null = null;
let extensionState: ExtensionState = {};
let connectedAt: string | null = null;
let relayPort: number | null = null;
let relayServer: WebSocketServer | null = null;

const browserServer = new McpServer({
  name: "aionda-browser-mcp",
  version: "0.2.1",
});

browserServer.tool("browser_status", "Return relay and attached-tab status.", {}, async () => {
  return textResult({
    relay: {
      host: options.host,
      port: relayPort,
      portPool: `${options.port}-${lastPoolPort()}`,
      connected: isExtensionConnected(),
      connectedAt,
      attached: extensionState.attached === true,
    },
    tab: extensionState,
  });
});

browserServer.tool("browser_tab", "Return the currently attached browser tab.", {}, async () => {
  if (!isExtensionConnected()) return errorResult("Chrome extension is not connected to the relay.");
  return textResult(extensionState);
});

browserServer.tool(
  "browser_attach",
  "Attach a Chrome tab to this agent and keep it when the user switches tabs. Select by tabId (from browser_list_tabs) or urlContains; without either, the active scriptable tab is used. followActive: true returns to following the active tab.",
  { urlContains: z.string().optional(), tabId: z.number().int().optional(), followActive: z.boolean().optional() },
  async ({ urlContains, tabId, followActive }) =>
    textResult(await sendCommand("attach", compactPayload({ urlContains, tabId, followActive }), 5000))
);

browserServer.tool(
  "browser_open_tab",
  "Open a URL in a new tab (or window) and attach it to this agent. Use this when other AI agents may be using the browser at the same time.",
  { url: z.string().url(), newWindow: z.boolean().optional(), active: z.boolean().optional() },
  async ({ url, newWindow, active }) => textResult(await sendCommand("openTab", compactPayload({ url, newWindow, active }), 5000))
);

browserServer.tool("browser_list_tabs", "List normal Chrome tabs visible to the extension, including which tab this agent and other agents are attached to.", {}, async () => {
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
  "Evaluate a JavaScript expression in an isolated page world via Chrome's Debugger API. Use only for trusted pages. Returns JSON-serializable results.",
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
  relayServer = await startRelayServer(options);

  const transport = new StdioServerTransport();
  await browserServer.connect(transport);
  exitWithClient();
}

// Each MCP client (AI agent) starts its own server. It takes the first free
// port of the pool; the extension connects to every port in the pool.
async function startRelayServer(serverOptions: ServerOptions): Promise<WebSocketServer> {
  const last = lastPoolPort();
  for (let port = serverOptions.port; port <= last; port += 1) {
    try {
      const wss = await listenOn(serverOptions, port);
      relayPort = port;
      console.error(`aionda-browser-mcp relay listening on ws://${serverOptions.host}:${port}/relay`);
      return wss;
    } catch (error) {
      if (!isAddressInUseError(error)) throw error;
    }
  }
  throw new Error(
    `All relay ports ${serverOptions.port}-${last} on ${serverOptions.host} are in use. ` +
      "Close another MCP client using the browser, or raise the port pool size in both the server and the extension."
  );
}

function listenOn({ host, token }: ServerOptions, port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port, path: "/relay" });

    wss.once("error", (error) => {
      wss.close();
      reject(error);
    });

    wss.once("listening", () => {
      wss.removeAllListeners("error");
      wss.on("error", (error) => console.error("aionda-browser-mcp relay error:", error));
      resolve(wss);
    });

    wss.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/relay", `http://${host}:${port}`);
      if (!isTokenValid(url.searchParams.get("token"), token)) {
        socket.close(1008, "invalid token");
        return;
      }

      if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        extensionSocket.close(1012, "replaced by a newer extension connection");
      }

      extensionSocket = socket;
      connectedAt = new Date().toISOString();
      extensionState = {};

      socket.on("message", (raw) => handleRelayMessage(raw.toString()));
      socket.on("close", () => {
        if (extensionSocket === socket) {
          extensionSocket = null;
          extensionState = {};
          connectedAt = null;
          rejectAllPending("Chrome extension disconnected.");
        }
      });
    });
  });
}

// A server outliving its MCP client would hold a pool port forever. Exit when
// stdin closes or the parent process is gone.
function exitWithClient() {
  const parentPid = process.ppid;
  const shutdown = () => {
    relayServer?.close();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  setInterval(() => {
    if (process.ppid !== parentPid) shutdown();
  }, 5000).unref();
}

function lastPoolPort() {
  return Math.min(65535, options.port + options.portCount - 1);
}

function isAddressInUseError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

function handleRelayMessage(raw: string) {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (!message || typeof message !== "object") return;
  const record = message as Record<string, unknown>;

  if (record.type === "state" && record.state && typeof record.state === "object") {
    extensionState = record.state as ExtensionState;
    return;
  }

  if (record.type !== "response" || typeof record.id !== "string") return;
  const pending = pendingRequests.get(record.id);
  if (!pending) return;
  pendingRequests.delete(record.id);
  clearTimeout(pending.timer);

  const response = record as { id: string; response?: RelayResponse };
  if (!response.response) {
    pending.reject(new Error("Malformed relay response."));
    return;
  }

  if (response.response.ok) pending.resolve(response.response.result);
  else pending.reject(new Error(response.response.error));
}

async function sendCommand(command: string, payload: JsonValue, timeoutMs = options.timeoutMs): Promise<JsonValue> {
  if (!isExtensionConnected() || !extensionSocket) {
    throw new Error("Chrome extension is not connected. Start the MCP server, load the extension, then click its toolbar icon on the target tab.");
  }

  const id = randomUUID();
  const message = JSON.stringify({ type: "command", id, command, payload });

  return await new Promise<JsonValue>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timed out waiting for browser command "${command}".`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });
    extensionSocket?.send(message, (error) => {
      if (!error) return;
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(error);
    });
  });
}

function rejectAllPending(message: string) {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
    pendingRequests.delete(id);
  }
}

function isExtensionConnected() {
  return extensionSocket?.readyState === WebSocket.OPEN;
}

function isTokenValid(received: string | null, expected: string) {
  if (!received) return false;
  const receivedHash = createHash("sha256").update(received).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(receivedHash, expectedHash);
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
  const portCount = Number(readFlag(args, "--port-count") ?? process.env.AIONDA_BROWSER_PORT_COUNT ?? DEFAULT_PORT_COUNT);
  return {
    host: readFlag(args, "--host") ?? process.env.AIONDA_BROWSER_HOST ?? DEFAULT_HOST,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
    portCount: Number.isInteger(portCount) ? Math.min(MAX_PORT_COUNT, Math.max(1, portCount)) : DEFAULT_PORT_COUNT,
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
