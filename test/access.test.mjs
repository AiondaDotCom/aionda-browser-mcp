import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeTabAccess,explainBrowserError} from '../dist/relay-client.js';

test('selected Store tabs report blocked scripting without losing their selection',()=>{
 for(const url of ['https://chrome.google.com/webstore/devconsole/publisher','https://chromewebstore.google.com/detail/item']){
  const state=describeTabAccess({tabId:7,attached:true,url});
  assert.equal(state.attached,true);
  assert.equal(state.tabId,7);
  assert.equal(state.contentScriptAvailable,false);
  assert.match(state.restriction,/Chrome/);
  assert.match(state.screenshotHint,/toolbar/);
 }
});
test('normal pages and explicit attachment failures remain distinguishable',()=>{
 assert.equal(describeTabAccess({attached:true,url:'https://example.com'}).contentScriptAvailable,true);
 const failed=describeTabAccess({attached:true,url:'https://example.com',error:'Site access denied'});
 assert.equal(failed.contentScriptAvailable,false);
 assert.equal(failed.restriction,'Site access denied');
 assert.equal(describeTabAccess({}).contentScriptAvailable,false);
});
test('browser errors give actionable diagnostics without changing unrelated errors',()=>{
 assert.match(explainBrowserError("The 'activeTab' permission is not in effect because this extension has not been in invoked."),/toolbar icon/);
 assert.match(explainBrowserError('The extensions gallery cannot be scripted.'),/Chrome Web Store/);
 assert.equal(explainBrowserError('No tab with id 4.'),'No tab with id 4.');
});
