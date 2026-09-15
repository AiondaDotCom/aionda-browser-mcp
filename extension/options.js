const DEFAULTS = { host: "127.0.0.1", port: 18792, token: "aionda-browser-dev", enabled: false };
const host = document.getElementById("host");
const port = document.getElementById("port");
const token = document.getElementById("token");
const enabled = document.getElementById("enabled");
const status = document.getElementById("status");
for (const button of document.querySelectorAll("[data-copy-target]")) {
  const label = button.getAttribute("aria-label");
  let resetTimer;
  button.addEventListener("click", async () => {
    try {
      let text = document.getElementById(button.dataset.copyTarget).textContent;
      if (button.dataset.copyTarget === "mcp-config") {
        const settings = readSettings();
        const configuration = JSON.parse(text);
        configuration.mcpServers["aionda-browser"].env = {
          AIONDA_BROWSER_HOST: settings.host,
          AIONDA_BROWSER_PORT: String(settings.port),
          AIONDA_BROWSER_TOKEN: settings.token,
        };
        text = JSON.stringify(configuration, null, 2);
      }
      await navigator.clipboard.writeText(text.trim());
      button.dataset.copied = "true";
      button.setAttribute("aria-label", "Copied!");
      button.title = "Copied!";
      status.style.color = "#137333";
      status.textContent = button.dataset.copyTarget === "mcp-config" ? "Configuration copied with the current host, port and token. Save any changed settings here too." : "Command copied.";
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        delete button.dataset.copied;
        button.setAttribute("aria-label", label);
        button.title = label;
      }, 2000);
    } catch {
      showError(new Error("Could not copy. Select the configuration or command and copy it manually."));
    }
  });
}
load().catch(showError);
document.getElementById("save").addEventListener("click", () => persist().catch(showError));
const toggleToken = document.getElementById("toggle-token");
toggleToken.addEventListener("click", () => {
  const visible = token.type === "password";
  token.type = visible ? "text" : "password";
  toggleToken.textContent = visible ? "Hide" : "Show";
  toggleToken.setAttribute("aria-label", visible ? "Hide relay token" : "Show relay token");
  toggleToken.setAttribute("aria-pressed", String(visible));
});
document.getElementById("copy-token").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(token.value);
    status.style.color = "#137333";
    status.textContent = "Token copied. Use it as AIONDA_BROWSER_TOKEN in your MCP server's environment.";
  } catch {
    showError(new Error("Could not copy. Click Show and copy the token manually."));
  }
});
async function load() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  host.value = settings.host;
  port.value = settings.port;
  token.value = settings.token;
  enabled.checked = settings.enabled === true;
}
function readSettings() {
  const localHost = host.value.trim() || DEFAULTS.host;
  const localPort = Number(port.value);
  if (!["127.0.0.1", "localhost"].includes(localHost)) throw new Error("Use 127.0.0.1 or localhost.");
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("Enter a port from 1 to 65535.");
  if (!token.value.trim()) throw new Error("Enter the same token as your MCP server.");
  return { host: localHost, port: localPort, token: token.value, enabled: enabled.checked };
}
async function persist() {
  await chrome.storage.local.set(readSettings());
  status.style.color = "#137333";
  status.textContent = enabled.checked ? "Saved. Browser access enabled." : "Saved. Browser access disabled.";
}
function showError(error) {
  status.style.color = "#b3261e";
  status.textContent = error.message;
}
