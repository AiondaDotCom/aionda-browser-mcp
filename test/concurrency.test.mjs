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
