const DEFAULTS = {
  host: "127.0.0.1",
  port: 18792,
  token: "aionda-browser-dev",
};

const host = document.getElementById("host");
const port = document.getElementById("port");
const token = document.getElementById("token");
const save = document.getElementById("save");
const status = document.getElementById("status");

load();
save.addEventListener("click", persist);

async function load() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  host.value = settings.host;
  port.value = settings.port;
  token.value = settings.token;
}

async function persist() {
  await chrome.storage.local.set({
    host: host.value.trim() || DEFAULTS.host,
    port: Number(port.value) || DEFAULTS.port,
    token: token.value || DEFAULTS.token,
  });
  status.textContent = "Saved";
  setTimeout(() => {
    status.textContent = "";
  }, 1500);
}
