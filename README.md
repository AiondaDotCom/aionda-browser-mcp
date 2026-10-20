# Aionda Browser MCP

Connect an MCP-compatible AI assistant to your existing Chrome tabs. Aionda Browser MCP consists of a Chrome extension and a local [Model Context Protocol](https://modelcontextprotocol.io/) server. It supports page snapshots, screenshots, navigation, clicks, typing, scrolling, JavaScript expressions and file uploads.

The extension connects to a WebSocket relay on your computer. Your MCP client starts the server and communicates with it over stdio. No Aionda account or cloud relay is required. Basic actions use Chrome extension APIs; coordinate clicks, file uploads and JavaScript evaluation use Chrome's Debugger API, without a remote debugging port.

## Installation

### 1. Install the Chrome extension

Install **Aionda Browser MCP** from the Chrome Web Store once its listing is available. During the initial store review, use the unpacked installation described under [Development](#development).

The extension opens its setup page after installation. You can reopen it by right-clicking the extension's toolbar icon and selecting **Options**.

### 2. Install Node.js

Install [Node.js 22 or newer](https://nodejs.org/) on the **same computer as Chrome**. npm and npx are included. Verify:

```sh
node --version
npm --version
```

### 3. Configure your MCP client

Use the copy icon inside the configuration block on the extension's Options page to include the current host, port and token automatically. Save any changed extension settings too. Alternatively, add the following entry to your MCP client's server configuration. Merge it with existing servers:

```json
{
  "mcpServers": {
    "aionda-browser": {
      "command": "npx",
      "args": ["-y", "aionda-browser-mcp@0.3.1"]
    }
  }
}
```

Restart the MCP client. It downloads the npm package and starts the server automatically. The first launch requires an internet connection.

On Windows, clients that cannot launch `npx` directly can use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "aionda-browser-mcp@0.3.1"]`.

#### Global installation

If you prefer to install the server explicitly, use **Copy command** on the Options page or run:

```sh
npm install --global aionda-browser-mcp@0.3.1
```

Then configure your MCP client with `"command": "aionda-browser-mcp"` and `"args": []`. If your desktop client cannot find the command, use its absolute path (`command -v aionda-browser-mcp` on macOS/Linux or `where aionda-browser-mcp` on Windows).

The server uses stdio. Running `aionda-browser-mcp` in a terminal starts a relay, but does not connect an AI assistant by itself. Normally, let your MCP client launch it.

### 4. Enable the extension

In the extension's **Options** page:

1. Leave host `127.0.0.1`, first port `18792`, `128` ports and token `aionda-browser-dev` for the initial local setup.
2. Read the browser-access disclosure.
3. Check **Enable browser access** and click **Save settings**.
4. Open a normal HTTP or HTTPS website. The badge shows **on** when a tab is attached to the running relay.
5. Ask your assistant to call `browser_status`, then `browser_snapshot_compact`.

While enabled, the extension follows the active tab. An MCP client can also select a tab with `browser_attach` or open its own with `browser_open_tab`. To stop access, uncheck **Enable browser access** and save, or disable the extension.

### Several AI agents at once

Each MCP client has a separate stdio connection and shares one independent relay.
Use `browser_attach(tabId)` or `browser_open_tab` to pin a tab to that client.
Normal commands for different tabs can run concurrently; operations for the same
tab and focus-sensitive operations are queued. Older extensions (before 0.3)
are supported through a serialized select-tab-and-command compatibility path.
See [Multiple agents and macOS service](#multiple-agents-and-macos-service).

### Custom token or port

Use the **eye icon** beside the relay token to reveal or conceal it, and the **copy icon** to copy its value. A checkmark briefly confirms a successful copy. Set the same values in the extension and in the MCP server's environment. A custom port selects the shared relay:

```json
{
  "mcpServers": {
    "aionda-browser": {
      "command": "npx",
      "args": ["-y", "aionda-browser-mcp@0.3.1"],
      "env": {
        "AIONDA_BROWSER_PORT": "18792",
        "AIONDA_BROWSER_TOKEN": "REPLACE_WITH_YOUR_OWN_RANDOM_TOKEN"
      }
    }
  }
}
```

Use your own random token on shared machines. Keep the relay on localhost. The default token is a development convenience, not a secret.

| Setting | Environment variable | Default |
| --- | --- | --- |
| Host | `AIONDA_BROWSER_HOST` | `127.0.0.1` |
| Relay port | `AIONDA_BROWSER_PORT` | `18792` |
| Token | `AIONDA_BROWSER_TOKEN` | `aionda-browser-dev` |
| Command timeout | `AIONDA_BROWSER_TIMEOUT_MS` | `10000` |

Equivalent CLI flags are `--host`, `--port`, `--token` and `--timeout-ms`. The relay port must be included in the extension's configured range.

## Tools

| Tools | Purpose |
| --- | --- |
| `browser_status`, `browser_tab` | Check the connection and attached tab |
| `browser_list_tabs`, `browser_attach`, `browser_open_tab` | Find, select or open a tab for this agent |
| `browser_snapshot`, `browser_snapshot_compact` | Read page text and interactive element references |
| `browser_click`, `browser_click_at` | Click an element or viewport coordinates |
| `browser_type`, `browser_press_key` | Fill fields and send keys |
| `browser_scroll`, `browser_scroll_into_view` | Scroll the page or reveal an element |
| `browser_navigate` | Navigate the attached tab |
| `browser_screenshot`, `browser_screenshot_fast` | Capture the visible viewport |
| `browser_evaluate` | Evaluate a JavaScript expression in an isolated page world through the Debugger API |
| `browser_upload_file` | Select local files for a page's file input |
| `browser_extension_reload` | Reload the extension |

Prefer `browser_snapshot_compact` for smaller text results and `browser_screenshot_fast` for a compressed image (960px wide by default). Coordinate clicks use original viewport coordinates: account for screenshot scaling and display pixel ratio. File uploads require absolute paths on the computer running Chrome and a file input in the main frame. JavaScript evaluation returns JSON-serializable values and has no access to extension APIs or page JavaScript globals.

## Troubleshooting

- **Badge off / extension disconnected:** Start or restart your MCP client, enable browser access, and check that the host, port and token match. Check Chrome's site-access setting for the extension.
- **Incompatible relay on the port:** Stop the old relay once when upgrading. The server never stops another process automatically.
- **Agents switch each other's tab:** Agents that follow the active tab move along when another agent brings its tab to the front. Use `browser_open_tab` or `browser_attach` to give each agent its own tab.
- **No tab attached:** Open a normal website and click the toolbar icon. Chrome restricts internal pages, the Web Store and some managed pages.
- **Node or npx not found:** Restart your desktop client after installing Node.js or use an absolute command path.
- **Debugger action fails:** Chrome may show a debugging banner. Another debugger or an enterprise policy can prevent coordinate clicks, uploads and evaluation.
- **Connection stops when a client exits:** The shared relay survives individual clients. Check the macOS service logs if the relay itself is unavailable.
- **Remote MCP client:** This release expects Chrome and the relay on the same computer. Installing the server on another host alone does not connect it to your local Chrome.

## Privacy and permissions

Browser access starts only after you enable it. Tab metadata, requested page content, screenshots and action results pass to your local MCP client. That client may send them to its AI provider and retain them under its own policies. Page content can contain personal or sensitive information; enable access only for trusted clients and pages.

The extension stores connection settings locally. It has no analytics, advertising, Aionda cloud endpoint or browsing-history database. Local file uploads transmit the selected files to the website you interact with. See the [privacy policy](PRIVACY.md).

Broad HTTP/HTTPS access lets the extension work across websites you select. `scripting` runs the bundled content script; `tabs` selects tabs and reads their metadata; `activeTab` supports toolbar attachment; `storage` saves settings and consent; `alarms` reconnects the local relay; `webNavigation` discovers frames; `debugger` supports coordinate clicks, file inputs and isolated JavaScript evaluation.

## Development

```sh
git clone https://github.com/AiondaDotCom/aionda-browser-mcp.git
cd aionda-browser-mcp
npm ci
npm run check
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the repository's `extension` directory. Complete the setup page. Configure your MCP client with `"command": "node"` and `"args": ["/absolute/path/to/aionda-browser-mcp/dist/server.js"]`.

Reload the extension after changing its files. Run `npm run package:extension` to generate the Chrome Web Store ZIP and `npm pack` to build the npm tarball. Release instructions and listing copy are in [store/LISTING.md](store/LISTING.md).

## Support and license

[Report an issue](https://github.com/AiondaDotCom/aionda-browser-mcp/issues). Do not include private page data or tokens in public issues. MIT licensed; see [LICENSE](LICENSE).

## Multiple agents and macOS service

Each Codex/Claude Code instance has its own stdio MCP process. All processes share
one authenticated WebSocket relay; concurrent starts do not compete for the port.
Without a service, the relay starts as a detached process on the first tool call
and exits after up to 30 seconds without MCP connections. Closing the client that
started it does not interrupt other clients. Failed commands are never replayed
automatically; the next call reconnects after a relay restart.

For a persistent macOS user service (starts at login and restarts on failure):

```bash
npm run service:install
launchctl print gui/$(id -u)/com.aionda.browser-relay
```

The installer uses this installation's absolute Node and relay paths. Reinstall
the service if you move the installation or change Node. Set
`AIONDA_BROWSER_TOKEN` and `AIONDA_BROWSER_PORT` when installing if customized.
Logs are in `~/Library/Logs/aionda-browser-mcp/relay.log`. To remove the service:

```bash
launchctl bootout gui/$(id -u)/com.aionda.browser-relay
rm ~/Library/LaunchAgents/com.aionda.browser-relay.plist
```

Each agent should call `browser_list_tabs`, then `browser_attach` with a `tabId`
(or `urlContains`). Its tab selection is pinned to that MCP connection; changing
the active Chrome tab or another agent's selection does not change it. Commands
for the same tab are queued. Different tabs can run concurrently; screenshots
and coordinate clicks are serialized globally because they change Chrome focus.
Multiple agents sharing one MCP connection also share its tab selection: give
each agent its own MCP connection for independent tabs. Agents editing the same
tab still need to coordinate multi-step workflows and snapshot references.

When upgrading from a relay embedded in an older MCP process, stop the old relay once and reload the unpacked Chrome
extension from this installation for full parallel execution. Older store extensions
remain usable with serialized commands. Old MCP processes also need to reconnect or
restart. The server never kills a process occupying the relay port automatically.

### Protected Chrome pages

`attached` means the tab is selected. Check `contentScriptAvailable` and
`restriction` before attempting automation. Chrome Web Store pages block
content scripts and extension debugger operations. If a screenshot reports an
`activeTab` error, click the Aionda Browser MCP toolbar icon on that tab and retry.
That gesture enables screenshots but does not enable scripting on protected pages.
