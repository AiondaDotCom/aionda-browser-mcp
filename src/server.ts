#!/usr/bin/env node
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
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
  token: string;
  timeoutMs: number;
};

const options = parseOptions(process.argv.slice(2));
const pendingRequests = new Map<string, PendingRequest>();
let extensionSocket: WebSocket | null = null;
let extensionState: ExtensionState = {};
let connectedAt: string | null = null;

const browserServer = new McpServer({
  name: "aionda-browser-mcp",
  version: "0.1.0",
});

browserServer.tool("browser_status", "Return relay and attached-tab status.", {}, async () => {
  return textResult({
    relay: {
      host: options.host,
      port: options.port,
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
  "browser_snapshot",
  "Get a text and element snapshot from the attached tab. Use element refs with click/type tools.",
  {},
  async () => textResult(await sendCommand("snapshot", {}))
);

browserServer.tool(
  "browser_click",
  "Click an element ref from browser_snapshot.",
  { ref: z.string(), button: z.enum(["left", "middle", "right"]).optional() },
  async ({ ref, button }) => textResult(await sendCommand("click", { ref, button: button ?? "left" }))
);

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
  },
  async ({ maxWidth, maxHeight, quality, format }) => imageResult(await sendCommand("screenshotFast", compactPayload({ maxWidth, maxHeight, quality, format }), 20000))
);

browserServer.tool(
  "browser_evaluate",
  "Run JavaScript in the attached tab content-script context. Use only for trusted pages.",
  { code: z.string() },
  async ({ code }) => textResult(await sendCommand("evaluate", { code }))
);

async function main() {
  startRelayServer(options);
  const transport = new StdioServerTransport();
  await browserServer.connect(transport);
}

function startRelayServer({ host, port, token }: ServerOptions) {
  const wss = new WebSocketServer({ host, port, path: "/relay" });

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

  wss.on("listening", () => {
    console.error(`aionda-browser-mcp relay listening on ws://${host}:${port}/relay`);
  });
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
