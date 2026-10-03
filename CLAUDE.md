# CLAUDE.md

Guidance for Claude Code and Codex in this repository.

## Project Scope

`aionda-browser-mcp` is a Chrome extension plus stdio MCP server for controlling a real user Chrome tab when Chrome DevTools Protocol is blocked or unreliable. Each MCP client starts its own `dist/server.js`, which binds the first free port of a pool (default `18792`–`18919`, `AIONDA_BROWSER_PORT`/`AIONDA_BROWSER_PORT_COUNT`). The extension connects to every server in the pool at `ws://127.0.0.1:<port>/relay`, so several AI agents can use Chrome at the same time.

## Development Commands

```bash
npm run check
npm run build
node --check extension/background.js
node --check extension/content.js
node --test tests/extension.test.mjs
node dist/server.js
```

After changing extension files, reload the unpacked extension in Chrome. If the Codex MCP transport is stale, restart Codex or test the server directly with the MCP SDK over stdio.

## Important Runtime Lessons

- The toolbar badge can only stay `on` while an MCP relay process is running. If a direct test client starts `dist/server.js`, the extension may show `on` briefly and then go `off` when that process exits.
- Do not add automatic port-kill behavior to the server. Starting a second test client must not kill the active Codex MCP server; it takes the next free pool port instead.
- `EADDRINUSE` on 18792 no longer blocks startup. If every pool port is taken, the server exits with "All relay ports ... are in use".
- The server exits when stdin closes or its parent process dies (checked every 5 seconds). Before this, an orphaned server (PPID 1) could hold 18792 for days and make Codex report `aionda-browser-mcp: failed (0 tools)`.
- In the extension, each pool port is a session with its own attached tab (`sessions` in `background.js`). Sessions follow the active tab until `browser_attach` or `browser_open_tab` pins a tab. Screenshots, coordinate clicks, evaluation and uploads run through one `exclusive()` queue because they focus the tab or need the tab's single debugger slot.
- A direct test client connects to the extension as an additional agent. While it runs, it follows the active tab like any other unpinned session.
- The extension can attach normal `http(s)` tabs, but not `chrome://` pages. Use `browser_list_tabs` or `browser_attach` to recover when Chrome is focused on `chrome://extensions`.
- On complex web apps, DOM snapshots may miss framework-rendered content. Prefer `browser_screenshot_fast` plus `browser_click_at` for visual workflows.
- `browser_screenshot_fast` returns a downscaled image, while `browser_click_at` expects original viewport coordinates. Scale coordinates back to the captured viewport before clicking.
- If content-script tools return `Could not establish connection. Receiving end does not exist.`, reattach/reload the extension, or use `browser_click_at` through the debugger path.
- For final dialogs that synthetic clicks do not activate, a real macOS click with `cliclick` can be used after focusing Chrome. `screencapture` reports Retina pixel dimensions; `cliclick` uses logical macOS coordinates, usually half the screenshot pixel coordinates on Retina displays.

## Direct MCP Smoke Test

Use this when Codex shows the MCP server but tools are missing or the transport is closed:

```bash
node --input-type=module <<'EOF'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['/Users/saf/dev/aionda-browser-mcp/dist/server.js'],
});
const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);
console.log((await client.listTools()).tools.map((tool) => tool.name).join(', '));
console.log((await client.callTool({ name: 'browser_status', arguments: {} })).content);
await client.close();
EOF
```

Expected core tools include:

- `browser_status`
- `browser_tab`
- `browser_attach`
- `browser_open_tab`
- `browser_list_tabs`
- `browser_snapshot`
- `browser_snapshot_compact`
- `browser_click`
- `browser_click_at`
- `browser_extension_reload`
- `browser_type`
- `browser_press_key`
- `browser_navigate`
- `browser_screenshot`
- `browser_screenshot_fast`
- `browser_evaluate`

## Browser Automation Notes

For authenticated admin dashboards, use the extension relay instead of Chrome DevTools when CDP is blocked or unreliable. A reliable workflow is:

1. Attach the authenticated tab.
2. Use `browser_screenshot_fast` to locate controls visually.
3. Use compact snapshots only when the page exposes useful accessible text.
4. Click visual controls with `browser_click_at` after scaling screenshot coordinates back to the original viewport.
5. Verify the resulting state with another screenshot before submitting destructive or publishing actions.

If a form reports that a selection is missing even though a checkbox was visibly clicked, the selection dialog may have been closed without persisting the value. Reopen the dialog, select the value, click the dialog confirmation button with correctly scaled coordinates, and verify the value appears in the main form before submitting again.

## Security

- Keep the relay bound to `127.0.0.1`.
- Use a non-default token on shared machines.
- Treat `browser_evaluate` as trusted-page only because it runs code in the attached tab context.
- The extension has broad host permissions by design; do not add network exposure to the relay.
