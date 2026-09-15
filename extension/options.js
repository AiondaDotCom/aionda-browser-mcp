const DEFAULTS = { host: "127.0.0.1", port: 18792, token: "aionda-browser-dev", enabled: false };
const host = document.getElementById("host");
const port = document.getElementById("port");
const token = document.getElementById("token");
const enabled = document.getElementById("enabled");
const status = document.getElementById("status");
load().catch(showError);
document.getElementById("save").addEventListener("click", () => persist().catch(showError));
async function load() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  host.value = settings.host;
  port.value = settings.port;
  token.value = settings.token;
  enabled.checked = settings.enabled === true;
}
async function persist() {
  const localHost = host.value.trim() || DEFAULTS.host;
  const localPort = Number(port.value);
  if (!["127.0.0.1", "localhost"].includes(localHost)) throw new Error("Use 127.0.0.1 or localhost.");
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("Enter a port from 1 to 65535.");
  if (!token.value.trim()) throw new Error("Enter the same token as your MCP server.");
  await chrome.storage.local.set({ host: localHost, port: localPort, token: token.value, enabled: enabled.checked });
  status.style.color = "#137333";
  status.textContent = enabled.checked ? "Saved. Browser access enabled." : "Saved. Browser access disabled.";
}
function showError(error) {
  status.style.color = "#b3261e";
  status.textContent = error.message;
}
