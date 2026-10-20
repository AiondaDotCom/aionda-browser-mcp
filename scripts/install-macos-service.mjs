#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('This installer requires macOS.');
const label = 'com.aionda.browser-relay';
const domain = `gui/${process.getuid()}`;
const directory = join(homedir(), 'Library', 'LaunchAgents');
const logs = join(homedir(), 'Library', 'Logs', 'aionda-browser-mcp');
const plist = join(directory, `${label}.plist`);
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const relay = resolve(fileURLToPath(new URL('../dist/relay.js', import.meta.url)));
await mkdir(directory, {recursive:true});
await mkdir(logs, {recursive:true});
await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(relay)}</string><string>--persistent</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict>
<key>AIONDA_BROWSER_HOST</key><string>127.0.0.1</string>
<key>AIONDA_BROWSER_PORT</key><string>${escape(process.env.AIONDA_BROWSER_PORT ?? '18792')}</string>
<key>AIONDA_BROWSER_TOKEN</key><string>${escape(process.env.AIONDA_BROWSER_TOKEN ?? 'aionda-browser-dev')}</string>
</dict>
<key>StandardOutPath</key><string>${escape(join(logs,'relay.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(logs,'relay.log'))}</string>
</dict></plist>\n`, {mode:0o600});
spawnSync('launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'});
const result = spawnSync('launchctl',['bootstrap',domain,plist],{stdio:'inherit'});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Installed ${label}: ${plist}`);
