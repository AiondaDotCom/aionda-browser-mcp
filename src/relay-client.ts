import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

type Options = { host: string; port: number; token: string; timeoutMs: number };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class RelayClient {
  private socket?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private pending = new Map<string, Pending>();
  private closed = false;
  private tabId?: number;
  private followActive = false;
  private selection?: Promise<any>;

  constructor(private options: Options) {}

  async request(command: string, payload: unknown, timeoutMs: number): Promise<any> {
    if (command === "status") {
      const status = await this.rpc(command, payload, timeoutMs);
      if (this.tabId !== undefined) {
        status.tab = await this.rpc("tab", { tabId: this.tabId }, timeoutMs);
        status.relay.attached = status.tab.attached === true;
      }
      return status;
    }
    if (!["attach", "openTab", "listTabs", "reloadExtension"].includes(command) && this.tabId === undefined && !this.followActive) {
      this.selection ??= this.request("attach", {}, timeoutMs).finally(() => { this.selection = undefined; });
      await this.selection;
    }
    const result = await this.rpc(command,
      ["attach", "openTab"].includes(command) || this.tabId === undefined ? payload : { ...(payload as object), tabId: this.tabId }, timeoutMs);
    if (["attach", "openTab"].includes(command) && result?.attached && Number.isInteger(result.tabId)) {
      this.followActive = command === "attach" && (payload as {followActive?: boolean}).followActive === true;
      this.tabId = this.followActive ? undefined : result.tabId;
    }
    return result;
  }

  private async rpc(command: string, payload: unknown, timeoutMs: number): Promise<any> {
    const socket = await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for browser command "${command}".`));
      }, timeoutMs + 1000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, command, payload: { ...(payload as object), _sharedClient: true }, timeoutMs }), (error) => {
        if (error) this.finish(id, undefined, error);
      });
    });
  }

  close() {
    this.closed = true;
    this.socket?.terminate();
    this.failPending();
  }

  private finish(id: string, value?: unknown, error?: Error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (error) pending.reject(error); else pending.resolve(value);
  }

  private failPending() {
    for (const id of this.pending.keys()) this.finish(id, undefined, new Error("Browser relay disconnected. Retry the command to reconnect."));
  }

  private connect(): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new Error("Relay client closed."));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (!this.connecting) {
      this.connecting = this.ensureRelay().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  private async ensureRelay(): Promise<WebSocket> {
    try { return await this.open(); } catch (error) {
      // Only a refused connection means the port is free. Never displace an existing server.
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL("./relay.js", import.meta.url))], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AIONDA_BROWSER_HOST: this.options.host,
        AIONDA_BROWSER_PORT: String(this.options.port), AIONDA_BROWSER_TOKEN: this.options.token,
        AIONDA_BROWSER_TIMEOUT_MS: String(this.options.timeoutMs) },
    });
    let spawnError: Error | undefined;
    child.on("error", (error) => { spawnError = error; });
    child.unref();
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError) throw spawnError;
      if (this.closed) throw new Error("Relay client closed.");
      await new Promise((resolve) => setTimeout(resolve, 50));
      try { return await this.open(); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
      }
    }
    throw new Error("Could not start the shared browser relay.");
  }

  private open(): Promise<WebSocket> {
    const url = new URL(`ws://${this.options.host.includes(":") ? `[${this.options.host}]` : this.options.host}:${this.options.port}/relay`);
    url.searchParams.set("token", this.options.token);
    url.searchParams.set("role", "client");
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let ready = false;
      const fail = (error: Error) => { clearTimeout(timer); reject(error); socket.terminate(); };
      const timer = setTimeout(() => fail(new Error("Port is occupied by an incompatible browser relay. Stop the old relay once and restart the MCP clients.")), 1500);
      socket.on("error", (error) => { if (!ready) fail(error); });
      socket.on("close", () => {
        clearTimeout(timer);
        if (!ready) reject(new Error("Browser relay rejected the connection. Check the token and relay version."));
        if (this.socket === socket) { this.socket = undefined; this.failPending(); }
      });
      socket.on("message", (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (!ready) {
          if (message.type !== "hello" || message.protocol !== "aionda-relay-v1") return;
          clearTimeout(timer);
          if (this.closed) { fail(new Error("Relay client closed.")); return; }
          ready = true;
          this.socket = socket;
          resolve(socket);
          return;
        }
        if (typeof message.id !== "string" || !message.response) return;
        this.finish(message.id, message.response.result,
          message.response.ok ? undefined : new Error(message.response.error));
      });
    });
  }
}
