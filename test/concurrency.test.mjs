import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function connect(port) {
  const client = new Client({ name: 'concurrency-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/server.js', '--port', String(port)], stderr: 'pipe' }));
  return client;
}
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};

for (const version of ['0.3.0', '0.2.1']) test(`parallel MCP clients retain tabs and survive owner exit with extension ${version}`, async () => {
  const port = await freePort();
  const clients = await Promise.all(Array.from({length: 6}, () => connect(port)));
  let extension;
  try {
    await Promise.all(clients.map(async c => assert.ok((await c.listTools()).tools.length >= 18)));
    await Promise.all(clients.map(c => call(c, 'browser_status')));
    extension = new WebSocket(`ws://127.0.0.1:${port}/relay?token=aionda-browser-dev`);
    await once(extension, 'open');
    extension.send(JSON.stringify({type:'state',state:{version,attached:true,tabId:999}}));
    let legacyTab = 999;
    extension.on('message', raw => {
      const {id,command,payload} = JSON.parse(raw);
      if (command === 'attach') legacyTab = payload.tabId;
      const selected = version === '0.2.1' ? legacyTab : payload.tabId;
      const result = command === 'attach' || command === 'tab'
        ? { attached:true,tabId:payload.tabId } : {tabId:selected, code:payload.code};
      setTimeout(() => extension.send(JSON.stringify({type:'response',id,response:{ok:true,result}})), Math.random()*30);
    });
    await Promise.all(clients.map((c,i) => call(c,'browser_attach',{tabId:i+1})));
    await Promise.all(clients.map(async (c,i) => {
      assert.equal((await call(c,'browser_evaluate',{code:String(i)})).tabId,i+1);
      assert.equal((await call(c,'browser_status')).tab.tabId,i+1);
    }));
    await clients[0].close();
    assert.equal((await call(clients[5],'browser_evaluate',{code:'still alive'})).tabId,6);
  } finally {
    extension?.close();
    await Promise.all(clients.map(c => c.close()));
  }
});

test('wrong token does not load zero tools or displace the existing relay', async () => {
  const port = await freePort();
  const relay = spawn(process.execPath,['dist/relay.js','--port',String(port),'--token','secret'],{stdio:'ignore'});
  await sleep(200);
  const client = await connect(port);
  try {
    assert.ok((await client.listTools()).tools.length >= 18);
    const result = await client.callTool({name:'browser_status',arguments:{}});
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/token/);
    assert.equal(relay.exitCode,null);
  } finally { await client.close(); relay.kill(); }
});

test('agents must claim their own tab and cannot take another agent\'s tab', async () => {
  const port = await freePort();
  const [a, b] = await Promise.all([connect(port), connect(port)]);
  let extension;
  const tool = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, text: result.content[0].text };
  };
  try {
    await call(a, 'browser_status');
    extension = new WebSocket(`ws://127.0.0.1:${port}/relay?token=aionda-browser-dev`);
    await once(extension, 'open');
    extension.send(JSON.stringify({type:'state',state:{version:'0.3.1',attached:true,tabId:1}}));
    const closed = new Set();
    const tabs = [{id:1,url:'https://outlook.live.com/mail/1'},{id:2,url:'https://outlook.live.com/mail/2'}];
    extension.on('message', raw => {
      const {id,command,payload} = JSON.parse(raw);
      let response;
      if (command === 'attach') {
        const free = tabs.filter(tab => !payload._claimedTabIds.includes(tab.id));
        const tab = payload.tabId ? tabs.find(t => t.id === payload.tabId) : free[0];
        response = {ok:true,result:{attached:true,tabId:tab.id,url:tab.url}};
      } else if (command === 'listTabs') {
        response = {ok:true,result:tabs.map(tab => ({...tab,attachedHere:false,otherAgents:0}))};
      } else if (closed.has(payload.tabId)) {
        response = {ok:false,error:`No tab with id: ${payload.tabId}.`};
      } else {
        response = {ok:true,result:{tabId:payload.tabId}};
      }
      extension.send(JSON.stringify({type:'response',id,response}));
    });

    const unclaimed = await tool(a, 'browser_snapshot_compact');
    assert.equal(unclaimed.error, true);
    assert.match(unclaimed.text, /No tab claimed by this agent.*browser_open_tab.*browser_attach/s);
    assert.match((await call(b, 'browser_status')).tab.error, /No tab claimed/);

    assert.equal((await call(a, 'browser_attach', {urlContains:'outlook'})).tabId, 1);
    assert.equal((await call(b, 'browser_attach', {urlContains:'outlook'})).tabId, 2);
    const taken = await tool(b, 'browser_attach', {tabId:1});
    assert.equal(taken.error, true);
    assert.match(taken.text, /already claimed by another AI agent/);
    assert.equal((await call(b, 'browser_evaluate', {code:'1'})).tabId, 2);
    assert.deepEqual((await call(b, 'browser_list_tabs')).map(t => [t.id, t.attachedHere, t.otherAgents]), [[1,false,1],[2,true,0]]);

    closed.add(2);
    const lost = await tool(b, 'browser_evaluate', {code:'1'});
    assert.match(lost.text, /^Your tab 2 was closed\. No tab claimed/);
    assert.match((await tool(b, 'browser_evaluate', {code:'1'})).text, /^No tab claimed/);

    await a.close();
    await sleep(100);
    assert.equal((await call(b, 'browser_attach', {tabId:1})).tabId, 1);
  } finally {
    extension?.close();
    await Promise.all([a.close(), b.close()]);
  }
});
