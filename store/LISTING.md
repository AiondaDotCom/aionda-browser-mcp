# Chrome Web Store release — Aionda Browser MCP

## Listing

- Name: Aionda Browser MCP
- Language: English
- Category: Developer Tools
- Price: Free
- Homepage: https://github.com/AiondaDotCom/aionda-browser-mcp
- Support: https://github.com/AiondaDotCom/aionda-browser-mcp/issues
- Privacy policy: https://aiondadotcom.github.io/aionda-browser-mcp/privacy.html
- ZIP: `release/aionda-browser-mcp-0.1.3-chrome.zip`

### Summary

Connect your AI assistant to Chrome for browser automation through a local MCP server. Requires Node.js and setup.

### Detailed description

Connect your AI assistant to the Chrome tabs you already use.

Aionda Browser MCP lets an MCP-compatible assistant read pages, capture screenshots and interact with websites through a local connection on your computer. Use it to test web interfaces, work through forms and automate browser tasks in your existing session.

FEATURES
• Read page text and interactive elements, with compact snapshots for smaller results.
• Capture full-resolution or compressed screenshots of the visible tab.
• Click, type, press keys, navigate and scroll.
• List browser tabs and select a tab by URL.
• Evaluate JavaScript expressions in an isolated page context.
• Select local files for upload to a website.

SETUP REQUIRED
This extension is a companion to the free aionda-browser-mcp npm package. It is not a standalone AI assistant. You need Node.js 22 or newer and an MCP-compatible client on the same computer as Chrome.

1. Install the extension and open its Options page.
2. Install Node.js from https://nodejs.org/.
3. Add the server to your MCP client using command "npx" and arguments ["-y", "aionda-browser-mcp@0.1.3"]. The client downloads and starts the server automatically. Alternatively, install it with: npm install -g aionda-browser-mcp@0.1.3
4. Restart your MCP client. In the extension's Options, read the disclosure, check "Enable browser access" and save.
5. Open a website. The extension badge shows "on" when connected. Ask your assistant to check browser_status.

Full instructions, configuration JSON and troubleshooting:
https://github.com/AiondaDotCom/aionda-browser-mcp#installation

LOCAL CONNECTION, YOUR CONTROL
No Aionda account or cloud relay. The extension connects only to localhost. While access is enabled, it follows your active tab. Your MCP client receives tab information, requested page content, screenshots and action results; that client may send these to its AI provider. Enable access only for trusted clients and pages. Disable it in Options at any time.

Chrome's Debugger API is used for coordinate clicks, JavaScript evaluation and file inputs. Chrome may display a debugging banner. Internal pages, Web Store pages and managed environments may restrict some actions. The extension and local server are free and open source; your chosen AI service may have its own costs.

Privacy policy:
https://aiondadotcom.github.io/aionda-browser-mcp/privacy.html

## Single purpose

Connect the user's selected Chrome tab to their local MCP client for user-directed browser automation: inspecting pages and screenshots, navigating and interacting with page controls.

## Permission justifications

- **activeTab:** Support the user's toolbar action to attach the selected tab and capture its viewport.
- **scripting:** Inject the packaged content.js file into user-selected HTTP/HTTPS pages to read page structure, locate controls, type and scroll.
- **tabs:** Read tab titles and URLs for the attached-tab status and list/select-tab tools, and activate or navigate the selected tab.
- **storage:** Store the localhost relay host, port, shared token and explicit browser-access preference locally.
- **webNavigation:** Discover frames in the selected tab so bundled content-script commands can reach a matching frame.
- **alarms:** Reconnect to the user's local relay after service-worker suspension or a client restart.
- **debugger:** Use Input.dispatchMouseEvent for coordinate clicks, DOM.setFileInputFiles for user-requested file inputs, and Runtime.evaluate in an isolated world for JavaScript expressions requested by the MCP client. No remote debugging port is needed. The debugger is detached in a finally block after each operation.
- **Host access (`<all_urls>`):** The user can choose any normal website for automation. Permissions allow bundled script injection and screenshot capture across those websites; access remains disabled until explicitly enabled in Options. Chrome requires `<all_urls>` for screenshot capture without a separate toolbar click on each tab; the extension only attaches HTTP/HTTPS pages.

## Remote code declaration

Yes, user/MCP-client-provided JavaScript expressions can be executed through Chrome's documented Debugger API (Runtime.evaluate in an isolated page world), solely for user-directed page inspection and automation. The implementation is in background.js, evaluateInTab. This uses the Debugger API exception described in the Manifest V3 requirements. There is no eval or Function-based execution in content scripts, no downloaded library, and no externally hosted extension code. Other operations use a fixed set of commands implemented in the packaged files.

Reference: https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements

## Data disclosures

Declare website content, web history (open/selected tab URLs and titles), and user activity (commands, interactions and form inputs). Since the extension can process arbitrary pages and form values/screenshots, also disclose personally identifiable information, health information, financial/payment information, authentication information, personal communications and location; such information may be present in user-selected page content even though no dedicated API collects it. All results go to the local MCP client, which may share them with its AI provider. There is no Aionda cloud collection, analytics, sale or advertising use.

The privacy policy explains local storage, in-memory relay processing, user control, third-party MCP/AI handling and Limited Use. Complete the dashboard declarations consistently with this behavior.

## Reviewer instructions

1. Install Node.js 22 or newer and the submitted extension. No Aionda account or paid service is required.
2. Install the server using `npm install -g aionda-browser-mcp@0.1.3` or configure an MCP client with command `npx` and arguments `["-y", "aionda-browser-mcp@0.1.3"]`.
3. Start the MCP client. Alternatively, launch `npx -y aionda-browser-mcp@0.1.3` in a terminal to verify relay connectivity only. Do not run two servers on the same port.
4. Open the extension's Options. Keep localhost, port 18792 and the initial development token aionda-browser-dev. Read the disclosure, enable browser access and save.
5. Open https://example.com/. The badge becomes on. Through an MCP client, call browser_status, browser_snapshot_compact and browser_screenshot_fast. The screenshot and text should match Example Domain.
6. Test browser_evaluate with code `document.title`. It uses Chrome's Debugger API and returns the page title. Chrome may display a debugging banner.
7. Clear Enable browser access and save. The badge becomes off and the relay reports disconnected.
8. No account login is required for any of these tests. Chrome restricts automation of internal/Store pages; use a normal website.

## Build and validation

```sh
npm ci
npm run check
npm run build
node --test tests/extension.test.mjs
node --check extension/background.js
node --check extension/content.js
node --check extension/options.js
npm run package:extension
npm pack --pack-destination release
```

Upload only the generated extension ZIP. Store images belong in store/assets and are not part of the extension runtime or npm package. npm publishing and store submission are separate: an uploaded store item becomes public only after Google's review.
