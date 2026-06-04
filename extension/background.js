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
      const screenshot = await captureAttachedTab({ format: "png" });
      return ok(screenshot);
    }

    if (command === "screenshotFast") {
      const screenshot = await captureAttachedTab({
        format: payload.format === "png" ? "png" : "jpeg",
        quality: clampNumber(payload.quality, 1, 100, 55),
        maxWidth: clampNumber(payload.maxWidth, 320, 1920, 960),
        maxHeight: clampNumber(payload.maxHeight, 0, 2160, 0),
      });
      return ok(screenshot);
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

async function captureAttachedTab(options) {
  const tab = await chrome.tabs.get(attachedTabId);
  if (!isScriptableUrl(tab.url)) throw new Error(unsupportedUrlMessage(tab.url));

  await chrome.tabs.update(attachedTabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await sleep(100);

  const captureOptions = options.format === "png"
    ? { format: "png" }
    : { format: "jpeg", quality: options.quality };
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOptions);
  return await resizeScreenshot(dataUrl, options);
}

async function resizeScreenshot(dataUrl, options) {
  const blob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  const maxWidth = options.maxWidth || originalWidth;
  const maxHeight = options.maxHeight || originalHeight;
  const scale = Math.min(1, maxWidth / originalWidth, maxHeight / originalHeight);
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  const mimeType = options.format === "png" ? "image/png" : "image/jpeg";

  if (width === originalWidth && height === originalHeight && blob.type === mimeType) {
    bitmap.close();
    return {
      dataUrl,
      mimeType,
      width,
      height,
      originalWidth,
      originalHeight,
      format: options.format,
      quality: options.format === "png" ? undefined : options.quality,
    };
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create screenshot canvas context.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const outputBlob = await canvas.convertToBlob({
    type: mimeType,
    quality: options.format === "png" ? undefined : options.quality / 100,
  });

  return {
    dataUrl: await blobToDataUrl(outputBlob),
    mimeType,
    width,
    height,
    originalWidth,
    originalHeight,
    format: options.format,
    quality: options.format === "png" ? undefined : options.quality,
  };
}

async function dataUrlToBlob(dataUrl) {
  return await (await fetch(dataUrl)).blob();
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
