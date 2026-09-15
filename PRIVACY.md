# Privacy Policy — Aionda Browser MCP

Effective date: September 15, 2026

Aionda Browser MCP is an open-source Chrome extension and local MCP server maintained by Aionda. This policy describes the software distributed through the Chrome Web Store and npm.

## Purpose and consent

The extension connects your browser to an MCP-compatible assistant for browser automation. Browser access is disabled until you enable it in the extension's settings. While enabled and connected, the extension follows your active tab and accepts browser commands from your local MCP client. You can disable access in settings or disable/uninstall the extension at any time.

## Information processed

- **Tab and browsing information:** Attached-tab URL, title and identifier are sent to the local relay as the selected tab changes. A tab-list request returns open-tab URLs and titles.
- **Website content:** On request, the extension reads page text, DOM elements and form values, or captures a visible-tab screenshot. Depending on the page, these results may include names, email addresses, private communications, authentication information entered into forms, financial information, health information, location or other sensitive data. We do not restrict the software to public pages; you control where it is enabled and used.
- **Actions and files:** Commands can click, type, navigate, scroll, evaluate JavaScript and select local files for upload. Commands and their results pass through the local relay. Requested uploads share the specified files with the website, under that website's policies.
- **Settings:** The extension stores the local relay host, port, token and your browser-access preference in Chrome's local extension storage. It does not sync these settings to an Aionda service.

The extension does not request Chrome's browsing-history or cookies permissions. It does not maintain its own browsing-history database.

## Where information goes

The extension communicates with a WebSocket relay on localhost, on the same computer as Chrome. The relay sends tool results to the MCP client over its local stdio connection. The MCP client and any AI service it uses may transmit, process and retain these results under their own policies. Review those policies before enabling access, particularly on sensitive pages.

Aionda Browser MCP has no Aionda-operated cloud relay, analytics endpoint or advertising service. The distributed extension and server do not send browser data to Aionda. Normal browser navigation and file uploads communicate with the websites you choose. Links to documentation and support open their respective websites.

## Retention, security and control

Connection settings remain in local extension storage until changed or removed by uninstalling the extension. The relay keeps connection state and pending command results in memory; it does not write a page-content or screenshot archive. Your MCP client, operating system or websites may retain their own logs or records.

The extension restricts relay connections to localhost and authenticates with a shared token. Use a custom random token on shared machines. The published development default is not secret. Keep the relay bound to localhost and use only trusted MCP clients.

Disable browser access and save settings to stop the connection. You can also stop the MCP client or remove the extension. Deleting any data retained by your MCP client or AI provider must be done with that provider.

## Use limitations

Browser information is processed solely to provide the browser automation requested through your MCP client. Aionda does not sell it, use it for advertising, or use it to determine creditworthiness or lending eligibility. Aionda Browser MCP's use of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Contact and changes

For privacy questions, use the project's [support page](https://github.com/AiondaDotCom/aionda-browser-mcp/issues). Do not post passwords, tokens or private page content in public issues. Policy updates will be published in this file with an updated effective date.
