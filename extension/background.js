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

const RECONNECT_ALARM = "aionda-browser-mcp-reconnect";

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...stored });
  setBadge("off", "#777777");
  startReconnectAlarm();
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  startReconnectAlarm();
  connect();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.host || changes.port || changes.token) reconnect();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!isSocketOpen()) connect();
  await attachTab(tab);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !isSocketOpen()) connect();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status === "complete") {
    attachTab(tab).catch(() => {});
    return;
  }

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
  const tab = await chrome.tabs.get(tabId);
  await attachTab(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== attachedTabId) return;
  attachedTabId = null;
  attachedTab = {};
  setBadge("off", "#777777");
  sendState();
});

connect();
startReconnectAlarm();

function startReconnectAlarm() {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.25 });
}

function isSocketOpen() {
  return socket?.readyState === WebSocket.OPEN;
}

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
    attachActiveTab().catch((error) => {
      attachedTab = { attached: false, version: chrome.runtime.getManifest().version, error: error instanceof Error ? error.message : String(error) };
      setBadge(attachedTabId ? "on" : "idle", attachedTabId ? "#137333" : "#fbbc04");
      sendState();
    });
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

async function attachActiveTab() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const tabs = windows.flatMap((window) => window.tabs || []).filter((tab) => tab.active);
  const tab = tabs.find((candidate) => isScriptableUrl(candidate.url)) || tabs[0];
  if (!tab) {
    attachedTabId = null;
    attachedTab = { attached: false, version: chrome.runtime.getManifest().version, error: "No active normal Chrome tab found." };
    setBadge("idle", "#fbbc04");
    sendState();
    return;
  }
  await attachTab(tab);
}

async function findAttachableTab(urlContains) {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const tabs = windows.flatMap((window) => window.tabs || []);
  const needle = typeof urlContains === "string" ? urlContains : "";
  return tabs.find((tab) => isScriptableUrl(tab.url) && (!needle || (tab.url || "").includes(needle))) || null;
}

async function listVisibleTabs() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return windows.flatMap((window) => (window.tabs || []).map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active === true,
    title: tab.title || "",
    url: tab.url || "",
    scriptable: isScriptableUrl(tab.url),
  })));
}

async function attachTab(tab) {
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
    if (command === "reloadExtension") {
      setTimeout(() => chrome.runtime.reload(), 100);
      return ok({ reloading: true });
    }

    if (command === "attach") {
      const tab = await findAttachableTab(payload.urlContains);
      if (!tab) throw new Error(payload.urlContains ? `No scriptable tab matching "${payload.urlContains}" found.` : "No scriptable tab found.");
      await attachTab(tab);
      return ok(attachedTab);
    }

    if (command === "listTabs") {
      return ok(await listVisibleTabs());
    }

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
        grayscale: payload.grayscale === true,
        maxBytes: clampNumber(payload.maxBytes, 0, 2000000, 0),
      });
      return ok(screenshot);
    }

    if (command === "clickAt") {
      return ok(await dispatchMouseClick(attachedTabId, payload));
    }

    if (command === "uploadFiles") {
      return ok(await uploadFiles(attachedTabId, payload));
    }

    await ensureContentScript(attachedTabId);
    const result = await sendCommandToAttachedFrames(attachedTabId, command, payload);
    if (result && result.ok === false) return result;
    return ok(result ?? null);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function dispatchMouseClick(tabId, payload) {
  const x = clampNumber(payload.x, 0, 10000, 0);
  const y = clampNumber(payload.y, 0, 10000, 0);
  const button = payload.button === "right" ? "right" : payload.button === "middle" ? "middle" : "left";
  const target = { tabId };
  const tab = await chrome.tabs.get(tabId);

  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await sleep(100);

  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1,
    });
    return { clickedAt: { x, y }, button, method: "debugger" };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// Set local files on a page file input via CDP DOM.setFileInputFiles — this bypasses
// the OS file picker entirely (the same approach Playwright/Puppeteer use). Paths must
// be absolute and exist on the machine running Chrome.
async function uploadFiles(tabId, payload) {
  const files = Array.isArray(payload.files)
    ? payload.files.filter((file) => typeof file === "string" && file.length > 0)
    : [];
  if (files.length === 0) {
    throw new Error("uploadFiles requires a non-empty 'files' array of absolute file paths.");
  }

  // Ask the content script to find and tag the target file input.
  await ensureContentScript(tabId);
  const mark = await sendCommandToAttachedFrames(tabId, "markFileInput", {
    ref: payload.ref,
    selector: payload.selector,
  });
  if (!mark || typeof mark.selector !== "string") {
    throw new Error("Could not locate a file input on the page.");
  }

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const doc = await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: 0 });
    const rootNodeId = doc?.root?.nodeId;
    if (!rootNodeId) throw new Error("Unable to read the page DOM via the debugger.");

    const found = await chrome.debugger.sendCommand(target, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector: mark.selector,
    });
    if (!found?.nodeId) throw new Error(`File input not found for selector ${mark.selector}.`);

    await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {
      files,
      nodeId: found.nodeId,
    });

    return { uploaded: files.length, files, multiple: mark.multiple === true, method: "debugger" };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
    await sendCommandToAttachedFrames(tabId, "unmarkFileInput", { selector: mark.selector }).catch(() => {});
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { command: "ping" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
  }
}

async function sendCommandToAttachedFrames(tabId, command, payload) {
  const frames = await getFrames(tabId);
  let lastError = null;

  for (const frame of frames) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { command, payload }, { frameId: frame.frameId });
      if (!result || result.ok !== false) return result;
      lastError = result.error || null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (lastError) throw new Error(lastError);
  throw new Error("No frame handled the browser command.");
}

async function getFrames(tabId) {
  if (!chrome.webNavigation?.getAllFrames) return [{ frameId: 0 }];
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return [{ frameId: 0 }, ...(frames || []).filter((frame) => frame.frameId !== 0)];
  } catch {
    return [{ frameId: 0 }];
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
  let width = Math.max(1, Math.round(originalWidth * scale));
  let height = Math.max(1, Math.round(originalHeight * scale));
  const mimeType = options.format === "png" ? "image/png" : "image/jpeg";

  if (width === originalWidth && height === originalHeight && blob.type === mimeType && !options.grayscale && !options.maxBytes) {
    bitmap.close();
    return {
      dataUrl,
      mimeType,
      width,
      height,
      originalWidth,
      originalHeight,
      bytes: blob.size,
      format: options.format,
      quality: options.format === "png" ? undefined : options.quality,
      grayscale: false,
      maxBytes: 0,
    };
  }

  let quality = (options.quality || 55) / 100;
  let outputBlob = await renderScreenshotBlob(bitmap, width, height, mimeType, quality, options.grayscale);
  const maxBytes = options.maxBytes || 0;

  for (let attempt = 0; maxBytes > 0 && outputBlob.size > maxBytes && attempt < 8; attempt += 1) {
    if (options.format !== "png" && quality > 0.3) {
      quality = Math.max(0.3, quality - 0.12);
    } else {
      width = Math.max(240, Math.round(width * 0.82));
      height = Math.max(160, Math.round(height * 0.82));
    }
    outputBlob = await renderScreenshotBlob(bitmap, width, height, mimeType, quality, options.grayscale);
  }

  bitmap.close();

  return {
    dataUrl: await blobToDataUrl(outputBlob),
    mimeType,
    width,
    height,
    originalWidth,
    originalHeight,
    bytes: outputBlob.size,
    format: options.format,
    quality: options.format === "png" ? undefined : Math.round(quality * 100),
    grayscale: options.grayscale === true,
    maxBytes,
  };
}

async function renderScreenshotBlob(bitmap, width, height, mimeType, quality, grayscale) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create screenshot canvas context.");
  context.drawImage(bitmap, 0, 0, width, height);

  if (grayscale) {
    const imageData = context.getImageData(0, 0, width, height);
    for (let index = 0; index < imageData.data.length; index += 4) {
      const gray = Math.round(0.299 * imageData.data[index] + 0.587 * imageData.data[index + 1] + 0.114 * imageData.data[index + 2]);
      imageData.data[index] = gray;
      imageData.data[index + 1] = gray;
      imageData.data[index + 2] = gray;
    }
    context.putImageData(imageData, 0, 0);
  }

  return await canvas.convertToBlob({
    type: mimeType,
    quality: mimeType === "image/png" ? undefined : quality,
  });
}

async function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Unexpected screenshot data URL.");

  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: match[1] });
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
