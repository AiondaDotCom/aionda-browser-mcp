import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

function harness() {
  const settings = { host: '127.0.0.1', port: 18792, portCount: 128, token: 'test', enabled: false };
  const calls = [];
  const tabs = [
    { id: 1, windowId: 1, active: true, url: 'https://one.example/', title: 'One' },
    { id: 2, windowId: 1, active: false, url: 'https://two.example/', title: 'Two' },
  ];
  const sockets = [];
  const listeners = {};
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const listener = { addListener() {} };
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    close() { this.readyState = 3; this.onclose?.(); }
    send(data) { calls.push(['send', data]); }
  }
  const chrome = {
    runtime: { onInstalled: listener, onStartup: listener, getManifest: () => ({ version: '0.1.0' }), openOptionsPage() {} },
    storage: { local: { get: async () => ({ ...settings }) }, onChanged: listener },
    action: { onClicked: listener, setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    alarms: { onAlarm: listener, create() {} },
    tabs: {
      onUpdated: listener, onActivated: listener, onRemoved: event('tabs.onRemoved'),
      get: async (id) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return tab;
      },
      update: async (id, props) => Object.assign(tabs.find((tab) => tab.id === id), props),
      sendMessage: async () => ({ ok: true }),
    },
    windows: { getAll: async () => [{ tabs }] },
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
  return { context, settings, calls, sockets, chrome, tabs, listeners };
}

test('connection is opt-in and disabling closes the socket', async () => {
  const h = harness();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sockets.length, 0);
  h.settings.enabled = true;
  await vm.runInContext('connect()', h.context);
  assert.equal(h.sockets.length, 128);
  assert.match(h.sockets[0].url, /^ws:\/\/127\.0\.0\.1:18792\/relay\?token=test$/);
  assert.match(h.sockets[127].url, /:18919\/relay/);
  h.settings.enabled = false;
  vm.runInContext('reconnect()', h.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(h.sockets.length, 128);
  const result = await vm.runInContext('runCommand({}, "listTabs", {})', h.context);
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

test('quick scans only cover the ports just above the highest open one', async () => {
  const h = harness();
  h.settings.enabled = true;
  await vm.runInContext('connect()', h.context);
  for (const socket of h.sockets) if (!/:1879[23]\//.test(socket.url)) socket.close();
  h.sockets[0].open();
  h.sockets[1].open();
  const before = h.sockets.length;
  await vm.runInContext('connect()', h.context);
  const ports = h.sockets.slice(before).map((socket) => Number(/:(\d+)\//.exec(socket.url)[1]));
  assert.deepEqual(ports, [18794, 18795, 18796, 18797, 18798, 18799, 18800, 18801]);
});

test('each agent keeps its own tab', async () => {
  const h = harness();
  h.settings.enabled = true;
  await vm.runInContext('connect()', h.context);
  h.sockets[0].open();
  h.sockets[1].open();
  await new Promise(resolve => setImmediate(resolve));
  const [a, b] = vm.runInContext('[sessions.get(18792), sessions.get(18793)]', h.context);
  assert.equal(a.attachedTabId, 1);
  assert.equal(b.attachedTabId, 1);
  const attached = await vm.runInContext('runCommand', h.context)(b, 'attach', { tabId: 2 });
  assert.equal(attached.result.tabId, 2);
  assert.equal(attached.result.followsActiveTab, false);
  assert.equal(a.attachedTabId, 1);
  const listed = await vm.runInContext('runCommand', h.context)(a, 'listTabs', {});
  assert.deepEqual(listed.result.map((tab) => [tab.id, tab.attachedHere, tab.otherAgents]), [[1, true, 0], [2, false, 1]]);
});

test('a late follow-the-active-tab attach does not undo browser_open_tab', async () => {
  const h = harness();
  h.settings.enabled = true;
  await vm.runInContext('connect()', h.context);
  h.sockets[0].open();
  await new Promise(resolve => setImmediate(resolve));
  const session = vm.runInContext('sessions.get(18792)', h.context);
  const runCommand = vm.runInContext('runCommand', h.context);
  const attachTab = vm.runInContext('attachTab', h.context);
  const newTab = { id: 3, windowId: 1, active: true, url: '', pendingUrl: 'https://three.example/' };
  h.chrome.tabs.create = async () => newTab;
  const opened = await runCommand(session, 'openTab', { url: 'https://three.example/' });
  // onActivated for the new tab is handled after the open command pinned it.
  await attachTab(session, newTab, { follow: true });
  assert.equal(opened.result.tabId, 3);
  assert.equal(session.attachedTabId, 3);
  assert.equal(session.pinned, true);
});

test('shared relay requests route to independent tabs without changing the default session', async () => {
  const h = harness();
  vm.runInContext(`
    lastSettings.enabled = true;
    const shared = {port:18792,socket:{readyState:1,send(){}},attachedTabId:999,attachedTab:{},pinned:false};
    const routed = [];
    sendCommandToAttachedFrames = async (tabId) => { routed.push(tabId); return {tabId}; };
  `,h.context);
  await vm.runInContext(`Promise.all([1,2].map(tabId => handleCommand(shared,JSON.stringify({
    type:'command',id:String(tabId),command:'snapshot',payload:{tabId,_sharedClient:true}
  }))))`,h.context);
  assert.deepEqual(Array.from(vm.runInContext('routed',h.context)).sort(),[1,2]);
  assert.equal(vm.runInContext('shared.attachedTabId',h.context),999);
});

test('shared relay queues same-tab operations while allowing other tabs', async () => {
  const h = harness();
  h.context.pause = () => new Promise(resolve => setImmediate(resolve));
  vm.runInContext(`
    const shared = {port:18792,socket:{readyState:1,send(){}},attachedTabId:999};
    const active = new Set(); let overlap = false; let parallel = false;
    runCommand = async (session,command,payload) => {
      if (active.has(payload.tabId)) overlap = true;
      active.add(payload.tabId);
      if (active.size > 1) parallel = true;
      await pause(); active.delete(payload.tabId);
      return {ok:true,result:null};
    };
  `,h.context);
  await vm.runInContext(`Promise.all([1,1,2].map((tabId,id) => handleCommand(shared,JSON.stringify({
    type:'command',id:String(id),command:'snapshot',payload:{tabId,_sharedClient:true}
  }))))`,h.context);
  assert.equal(vm.runInContext('overlap',h.context),false);
  assert.equal(vm.runInContext('parallel',h.context),true);
});

test('restricted tab status distinguishes selection from content-script access',()=>{
 const h=harness();
 const state=vm.runInContext('tabToState',h.context)({id:7,url:'https://chrome.google.com/webstore/devconsole/publisher'},true);
 assert.equal(state.attached,true);
 assert.equal(state.tabId,7);
 assert.equal(state.contentScriptAvailable,false);
 assert.match(state.restriction,/toolbar icon/);
});
test('screenshot permission failures explain the toolbar gesture',async()=>{
 const h=harness();
 vm.runInContext(`lastSettings.enabled=true; captureTab=async()=>{throw new Error("The 'activeTab' permission is not in effect because this extension has not been in invoked.")}`,h.context);
 const result=await vm.runInContext('runCommand',h.context)({attachedTabId:1,pinned:true},'screenshot',{});
 assert.equal(result.ok,false);
 assert.match(result.error,/toolbar icon/);
});

async function twoAgents(h) {
  h.settings.enabled = true;
  await vm.runInContext('connect()', h.context);
  h.sockets[0].open();
  h.sockets[1].open();
  await new Promise(resolve => setImmediate(resolve));
  return [vm.runInContext('[sessions.get(18792), sessions.get(18793)]', h.context), vm.runInContext('runCommand', h.context)];
}

test('page tools require a claimed tab with an actionable error', async () => {
  const h = harness();
  const [[a], runCommand] = await twoAgents(h);
  assert.equal(a.attachedTabId, 1);
  for (const command of ['snapshot', 'navigate', 'screenshotFast', 'clickAt', 'evaluate']) {
    const result = await runCommand(a, command, { url: 'https://x.example/' });
    assert.equal(result.ok, false, command);
    assert.match(result.error, /No tab claimed by this agent/);
    assert.match(result.error, /browser_open_tab/);
    assert.match(result.error, /browser_attach/);
  }
  assert.equal((await runCommand(a, 'listTabs', {})).ok, true);
  assert.equal((await runCommand(a, 'attach', { tabId: 1 })).ok, true);
  const navigated = await runCommand(a, 'navigate', { url: 'https://x.example/' });
  assert.equal(navigated.ok, true);
  assert.equal(h.tabs[0].url, 'https://x.example/');
  const released = await runCommand(a, 'attach', { followActive: true });
  assert.equal(released.result.followsActiveTab, true);
  assert.match((await runCommand(a, 'snapshot', {})).error, /No tab claimed/);
});

test('two agents on the same website get different tabs', async () => {
  const h = harness();
  h.tabs[1].url = 'https://outlook.live.com/mail/1';
  h.tabs.push({ id: 3, windowId: 1, active: false, url: 'https://outlook.live.com/mail/2', title: 'Mail 2' });
  const [[a, b], runCommand] = await twoAgents(h);
  const first = await runCommand(a, 'attach', { urlContains: 'outlook' });
  const second = await runCommand(b, 'attach', { urlContains: 'outlook' });
  assert.equal(first.result.tabId, 2);
  assert.equal(second.result.tabId, 3);
  const taken = await runCommand(b, 'attach', { tabId: 2 });
  assert.equal(taken.ok, false);
  assert.match(taken.error, /already claimed by another AI agent/);
  assert.equal(b.attachedTabId, 3);
  const listed = await runCommand(b, 'listTabs', {});
  assert.deepEqual(listed.result.map((tab) => [tab.id, tab.attachedHere, tab.otherAgents]), [[1, false, 0], [2, false, 1], [3, true, 0]]);
});

test('a closed tab is reported and must be claimed again', async () => {
  const h = harness();
  const [[a], runCommand] = await twoAgents(h);
  await runCommand(a, 'attach', { tabId: 2 });
  h.tabs.splice(1, 1);
  h.listeners['tabs.onRemoved'](2);
  const result = await runCommand(a, 'snapshot', {});
  assert.match(result.error, /^Your tab 2 \(https:\/\/two\.example\/\) was closed\. No tab claimed/);
  const missing = await runCommand(a, 'attach', { tabId: 2 });
  assert.match(missing.error, /Tab 2 does not exist/);
});

test('debugger work on different tabs runs in parallel, focus work one at a time', async () => {
  const h = harness();
  const exclusive = vm.runInContext('exclusive', h.context);
  const focusLock = vm.runInContext('focusLock', h.context);
  const tabLock = vm.runInContext('tabLock', h.context);
  const events = [];
  const task = (name) => async () => {
    events.push(`start ${name}`);
    await new Promise(resolve => setTimeout(resolve, 10));
    events.push(`end ${name}`);
  };
  await Promise.all([exclusive(tabLock(1), task('eval1')), exclusive(tabLock(2), task('eval2'))]);
  assert.deepEqual(events.slice(0, 2), ['start eval1', 'start eval2']);
  events.length = 0;
  await Promise.all([exclusive(focusLock(1), task('shot1')), exclusive(focusLock(2), task('shot2'))]);
  assert.deepEqual(events, ['start shot1', 'end shot1', 'start shot2', 'end shot2']);
  events.length = 0;
  await Promise.all([exclusive(focusLock(1), task('shot1')), exclusive(tabLock(1), task('eval1')), exclusive(tabLock(2), task('eval2'))]);
  assert.deepEqual(events.slice(0, 2), ['start shot1', 'start eval2']);
  assert.ok(events.indexOf('start eval1') > events.indexOf('end shot1'));
  await assert.rejects(exclusive(tabLock(1), async () => { throw new Error('boom'); }), /boom/);
  await exclusive(tabLock(1), task('after error'));
  assert.equal(vm.runInContext('locks.size', h.context), 0);
});
