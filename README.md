# Aionda Browse MCP

Aionda Browse MCP is a small Chrome extension plus local MCP server for browser automation when Chrome DevTools Protocol is unavailable or blocked by the page.

The extension attaches the active Chrome tab to a localhost WebSocket relay. Claude Code, Codex, or another MCP client talks to the local MCP server over stdio. Browser actions are executed through normal extension/content-script APIs, not through DevTools.

## Status

This is an early MVP. It supports one attached tab at a time and exposes the core actions needed for assisted browsing:

- `browser_status`
- `browser_tab`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_press_key`
- `browser_navigate`
- `browser_screenshot`
- `browser_evaluate`

## Install

```bash
cd ~/dev/aionda-browse-mcp
npm install
npm run build
```

Then load the Chrome extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select `~/dev/aionda-browse-mcp/extension`.

Start the MCP server:

```bash
node ~/dev/aionda-browse-mcp/dist/server.js
```

Click the extension toolbar icon on the browser tab you want to control. The badge changes to `on` when a tab is attached.

## MCP Client Configuration

Example config:

```json
{
  "mcpServers": {
    "aionda-browse": {
      "command": "node",
      "args": ["/Users/saf/dev/aionda-browse-mcp/dist/server.js"],
      "env": {
        "AIONDA_BROWSE_TOKEN": "aionda-browse-dev"
      }
    }
  }
}
```

The extension options page must use the same token as the server. Defaults:

- Host: `127.0.0.1`
- Port: `18792`
- Token: `aionda-browse-dev`

## Why This Exists

Chrome DevTools MCP and Playwright are excellent when CDP is available. Some sites block or degrade DevTools automation, especially authenticated admin dashboards. This project uses the extension permission model instead: user-attached tab, content script snapshot, and synthetic user actions.

## Security Notes

- Keep the relay bound to `127.0.0.1`.
- Use a non-default token for shared or sensitive machines.
- The extension has `<all_urls>` host permission because it is meant to work across arbitrary authenticated pages.
- `browser_evaluate` runs code in the content-script context of the attached tab. Use it only on pages you trust.

## Development

```bash
npm run check
npm run build
```

After changing extension files, reload the unpacked extension from `chrome://extensions`.
