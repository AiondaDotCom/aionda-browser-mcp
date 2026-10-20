#!/usr/bin/env node
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

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

export function startRelayServer({ host, port, token }: ServerOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port, path: "/relay" });
    const clients = new Set<WebSocket>();
    const idle = setInterval(() => {
      if (clients.size === 0 && !process.argv.includes("--persistent")) process.exit(0);
    }, 30000);
    idle.unref();

    wss.on("error", (error) => {
      console.error("aionda-browser-mcp relay error:", error.message);
      reject(error);
    });

    wss.on("listening", () => {
      console.error(`aionda-browser-mcp relay listening on ws://${host}:${port}/relay`);
      resolve();
    });

    wss.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/relay", `http://${host}:${port}`);
      if (!isTokenValid(url.searchParams.get("token"), token)) {
        socket.close(1008, "invalid token");
        return;
      }

      if (url.searchParams.get("role") === "client") {
        clients.add(socket);
        socket.send(JSON.stringify({ type: "hello", protocol: "aionda-relay-v1" }));
        socket.on("close", () => clients.delete(socket));
        socket.on("message", async (raw) => {
          let request;
          try { request = JSON.parse(raw.toString()); } catch { return; }
          if (!request || typeof request !== "object") return;
          if (typeof request.id !== "string" || typeof request.command !== "string") return;
          let response: RelayResponse;
          try {
            const result = request.command === "status"
              ? { relay: { host, port, connected: isExtensionConnected(), connectedAt,
                  attached: extensionState.attached === true }, tab: extensionState }
              : await dispatchCommand(request.command, request.payload ?? {}, request.timeoutMs);
            response = { ok: true, result: result as JsonValue };
          } catch (error) {
            response = { ok: false, error: String(error instanceof Error ? error.message : error) };
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: request.id, response }));
        });
        return;
      }

      if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        rejectAllPending("Chrome extension connection replaced.");
        extensionSocket.close(1012, "replaced by a newer extension connection");
      }

      extensionSocket = socket;
      connectedAt = new Date().toISOString();
      extensionState = {};

      socket.on("message", (raw) => { if (extensionSocket === socket) handleRelayMessage(raw.toString()); });
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

let legacyQueue: Promise<unknown> = Promise.resolve();

function dispatchCommand(command: string, payload: JsonValue, timeoutMs: number): Promise<JsonValue> {
  const version = (extensionState.version ?? "0.0.0").split(".").map(Number);
  if (version[0] > 0 || version[1] >= 3) return sendCommand(command, payload, timeoutMs);
  // Store versions before 0.3 know only one session per socket. Make selecting
  // the requested tab and executing its command one indivisible operation.
  const run = legacyQueue.catch(() => {}).then(async () => {
    if (payload && typeof payload === "object" && "tabId" in payload &&
        !["attach", "openTab"].includes(command)) {
      const tab = await sendCommand("attach", { tabId: payload.tabId }, timeoutMs);
      if (command === "tab") return tab;
    }
    return sendCommand(command, payload, timeoutMs);
  });
  legacyQueue = run;
  return run;
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

startRelayServer(options).catch((error) => {
  if (!isAddressInUseError(error)) console.error(error);
  process.exit(isAddressInUseError(error) ? 0 : 1);
});
