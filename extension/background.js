const DEFAULTS = {
  host: "127.0.0.1",
  port: 18792,
  token: "aionda-browser-dev",
};

let socket = null;
let socketGeneration = 0;
let reconnectTimer = null;
let attachedTabId = null;
let attachedTab = {};
let lastSettings = { ...DEFAULTS };

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...stored });
  setBadge("off", "#777777");
  connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.host || changes.port || changes.token) reconnect();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  if (!isScriptableUrl(tab.url)) {
    attachedTabId = null;
    attachedTab = tabToState(tab, false, unsupportedUrlMessage(tab.url));
    setBadge("no", "#d93025");
    sendState();
    return;
  }

  try {
    attachedTabId = tab.id;
    attachedTab = tabToState(tab, true);
    await ensureContentScript(tab.id);
    setBadge("on", "#137333");
  } catch (error) {
    attachedTabId = null;
    attachedTab = tabToState(tab, false, error instanceof Error ? error.message : String(error));
    setBadge("no", "#d93025");
  }

  sendState();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== attachedTabId) return;
  if (!isScriptableUrl(tab.url)) {
    attachedTabId = null;
    attachedTab = tabToState(tab, false, unsupportedUrlMessage(tab.url));
    setBadge("no", "#d93025");
    sendState();
    return;
  }
  attachedTab = tabToState(tab, true);
  sendState();
  if (changeInfo.status === "complete") ensureContentScript(tabId).catch(() => {});
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (tabId !== attachedTabId) return;
  const tab = await chrome.tabs.get(tabId);
  if (!isScriptableUrl(tab.url)) {
    attachedTabId = null;
    attachedTab = tabToState(tab, false, unsupportedUrlMessage(tab.url));
    setBadge("no", "#d93025");
    sendState();
    return;
  }
  attachedTab = tabToState(tab, true);
  sendState();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== attachedTabId) return;
  attachedTabId = null;
  attachedTab = {};
  setBadge("off", "#777777");
  sendState();
});

connect();

async function connect() {
  clearTimeout(reconnectTimer);
  lastSettings = await chrome.storage.local.get(DEFAULTS);
  const url = `ws://${lastSettings.host}:${lastSettings.port}/relay?token=${encodeURIComponent(lastSettings.token)}`;
  const generation = ++socketGeneration;

  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    if (generation !== socketGeneration) return;
    setBadge(attachedTabId ? "on" : "idle", attachedTabId ? "#137333" : "#fbbc04");
    sendState();
  };

  socket.onmessage = (event) => {
    if (generation !== socketGeneration) return;
    handleCommand(event.data).catch((error) => {
      console.error("Aionda Browser MCP command failed", error);
    });
  };

  socket.onclose = () => {
    if (generation !== socketGeneration) return;
    setBadge("off", "#777777");
    scheduleReconnect();
  };

  socket.onerror = () => {
    if (generation !== socketGeneration) return;
    try {
      socket.close();
    } catch {
      scheduleReconnect();
    }
  };
}

function reconnect() {
  if (socket) socket.close();
  connect();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 1500);
}

async function handleCommand(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (!message || message.type !== "command") return;
  const { id, command, payload } = message;
  const response = await runCommand(command, payload ?? {});
  send({ type: "response", id, response });
}

async function runCommand(command, payload) {
  try {
    if (!attachedTabId) throw new Error("No tab is attached. Click the extension icon on the target tab.");

    if (command === "navigate") {
      const tab = await chrome.tabs.update(attachedTabId, { url: payload.url });
      attachedTab = tabToState(tab, true);
      sendState();
      return ok(attachedTab);
    }

    if (command === "screenshot") {
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
      return ok({ dataUrl });
    }

    await ensureContentScript(attachedTabId);
    const result = await chrome.tabs.sendMessage(attachedTabId, { command, payload });
    if (result && result.ok === false) return result;
    return ok(result ?? null);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { command: "ping" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

function tabToState(tab, attached, error) {
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    attached,
    version: chrome.runtime.getManifest().version,
    error,
  };
}

function isScriptableUrl(url) {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function unsupportedUrlMessage(url) {
  return `Cannot attach to this URL. Chrome extensions cannot inject content scripts into ${url || "this tab"}. Open a normal http(s) page and click the extension icon there.`;
}

function sendState() {
  send({ type: "state", state: attachedTabId ? attachedTab : { attached: false, version: chrome.runtime.getManifest().version } });
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function ok(result) {
  return { ok: true, result };
}

function fail(error) {
  return { ok: false, error };
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
