import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

function harness() {
  const settings = { host: '127.0.0.1', port: 18792, token: 'test', enabled: false };
  const calls = [];
  const sockets = [];
  const listener = { addListener() {} };
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
    send(data) { calls.push(['send', data]); }
  }
  const chrome = {
    runtime: { onInstalled: listener, onStartup: listener, getManifest: () => ({ version: '0.1.0' }), openOptionsPage() {} },
    storage: { local: { get: async () => ({ ...settings }) }, onChanged: listener },
    action: { onClicked: listener, setBadgeText() {}, setBadgeBackgroundColor() {} },
    alarms: { onAlarm: listener, create() {} },
    tabs: { onUpdated: listener, onActivated: listener, onRemoved: listener },
    debugger: {
      attach: async (...args) => calls.push(['attach', ...args]),
      detach: async (...args) => calls.push(['detach', ...args]),
      sendCommand: async (_target, command, params) => {
        calls.push([command, params]);
        if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        if (command === 'Page.createIsolatedWorld') return { executionContextId: 42 };
        if (command === 'Runtime.evaluate') return { result: { value: { title: 'Test' } } };
      },
    },
  };
  const context = vm.createContext({ chrome, WebSocket: Socket, URL, console, clearTimeout() {}, setTimeout() {} });
  vm.runInContext(source, context);
  return { context, settings, calls, sockets, chrome };
}

test('connection is opt-in and disabling closes the socket', async () => {
  const h = harness();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sockets.length, 0);
  h.settings.enabled = true;
  await vm.runInContext('connect()', h.context);
  assert.equal(h.sockets.length, 1);
  assert.match(h.sockets[0].url, /^ws:\/\/127\.0\.0\.1:18792\/relay\?token=test$/);
  h.settings.enabled = false;
  vm.runInContext('reconnect()', h.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(h.sockets.length, 1);
  const result = await vm.runInContext('runCommand("listTabs", {})', h.context);
  assert.equal(result.ok, false);
  assert.match(result.error, /disabled/);
});

test('evaluation uses an isolated debugger context and releases it', async () => {
  const h = harness();
  const result = await vm.runInContext('evaluateInTab(123, "({title: document.title})")', h.context);
  assert.equal(result.title, 'Test');
  const evaluation = h.calls.find(([name]) => name === 'Runtime.evaluate')[1];
  assert.equal(evaluation.contextId, 42);
  assert.equal(evaluation.awaitPromise, true);
  assert.equal(evaluation.returnByValue, true);
  assert.equal(h.calls.at(-1)[0], 'detach');
});

test('evaluation errors are surfaced and debugger is detached', async () => {
  const h = harness();
  const original = h.chrome.debugger.sendCommand;
  h.chrome.debugger.sendCommand = async (...args) => args[1] === 'Runtime.evaluate'
    ? { exceptionDetails: { exception: { description: 'ReferenceError: missing' } } }
    : original(...args);
  await assert.rejects(vm.runInContext('evaluateInTab(123, "missing")', h.context), /ReferenceError: missing/);
  assert.equal(h.calls.at(-1)[0], 'detach');
});
