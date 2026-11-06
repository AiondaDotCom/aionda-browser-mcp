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

  constructor(private options: Options) {}

  async request(command: string, payload: unknown, timeoutMs: number): Promise<any> {
    if (command === "status") {
      const status = await this.rpc(command, payload, timeoutMs);
      if (this.tabId !== undefined) {
        status.tab = await this.rpc("tab", { tabId: this.tabId }, timeoutMs).catch((error) => this.lostTab(error));
        status.relay.attached = status.tab.attached === true;
      } else {
        status.tab = { attached: false, claimed: false, error: unclaimedTabMessage() };
        status.relay.attached = false;
      }
      status.tab = describeTabAccess(status.tab);
      return status;
    }
    const claiming = ["attach", "openTab"].includes(command);
    // Several agents share the browser, so page tools only run in a tab this
    // client claimed. Following the active tab could hit another agent's tab.
    if (!claiming && !CLAIM_FREE_COMMANDS.has(command) && this.tabId === undefined) {
      throw new Error(unclaimedTabMessage());
    }
    if (command === "attach" && (payload as { followActive?: boolean }).followActive === true) this.tabId = undefined;
    const result = await this.rpc(command,
      claiming || this.tabId === undefined ? payload : { ...(payload as object), tabId: this.tabId }, timeoutMs)
      .catch((error) => { throw claiming || this.tabId === undefined ? error : this.lostTab(error); });
    if (claiming && result?.attached && Number.isInteger(result.tabId)) {
      const released = command === "attach" && (payload as { followActive?: boolean }).followActive === true;
      this.tabId = released ? undefined : result.tabId;
      if (released) return { ...describeTabAccess(result), claimed: false, note: "Tab released. Claim a tab before using page tools again." };
    }
    return ["attach", "openTab", "tab", "navigate"].includes(command) ? describeTabAccess(result) : result;
  }

  // Chrome reports "No tab with id" once the claimed tab is closed. Forget the
  // tab so the agent gets a clear instruction instead of a Chrome error.
  private lostTab(error: Error): Error {
    if (this.tabId === undefined || !/No tab with id/i.test(error.message)) return error;
    const tabId = this.tabId;
    this.tabId = undefined;
    return new Error(`Your tab ${tabId} was closed. ${unclaimedTabMessage()}`);
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
          message.response.ok ? undefined : new Error(explainBrowserError(message.response.error)));
      });
    });
  }
}

const CLAIM_FREE_COMMANDS = new Set(["listTabs", "reloadExtension"]);

export function unclaimedTabMessage() {
  return "No tab claimed by this agent. Other AI agents may use this browser at the same time, so page tools only run in a tab the agent claimed first. " +
    "Fix: call browser_open_tab with {url} to open your own tab, or call browser_list_tabs and then browser_attach with {tabId} to claim an existing tab. Then retry this command.";
}

// Add actionable diagnostics even when the installed Store extension predates them.
export function describeTabAccess(tab: any) {
  if (!tab || typeof tab !== "object") return tab;
  let protectedPage = false;
  try {
    const url = new URL(tab.url);
    protectedPage = url.hostname === "chromewebstore.google.com" ||
      (url.hostname === "chrome.google.com" && /^\/webstore(?:\/|$)/.test(url.pathname));
  } catch { /* No tab URL yet. */ }
  const restriction = protectedPage ? explainBrowserError("The extensions gallery cannot be scripted.") : tab.restriction || tab.error;
  return { ...tab, contentScriptAvailable: tab.attached === true && !restriction,
    ...(restriction ? { restriction } : {}),
    ...(protectedPage ? { screenshotHint: "If capture reports an activeTab error, click the extension toolbar icon on this tab and retry." } : {}) };
}

export function explainBrowserError(message: string): string {
  if (/extensions gallery cannot be scripted/i.test(message)) {
    return "Chrome blocks extension scripting and debugger actions on Chrome Web Store pages, including the developer dashboard. Snapshots, clicks, typing, evaluation and uploads are unavailable there. Use the dashboard manually; navigation and tab listing still work. A screenshot requires clicking the Aionda Browser MCP toolbar icon on that tab first.";
  }
  if (/activeTab.*(?:permission|invoked)|permission.*activeTab/i.test(message)) {
    return "Chrome requires a user gesture to capture this protected page. Click the Aionda Browser MCP toolbar icon on this tab, then retry the screenshot. This does not unlock scripting or debugger actions on Chrome Web Store pages.";
  }
  return message;
}
