import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {starterFiles} from '../dist/scaffold.js';
const pins=JSON.parse(await readFile(new URL('../compatibility.json',import.meta.url),'utf8'));
for(const enabled of [true,false]){
 const files=await starterFiles(pins,enabled);const p=JSON.parse(files['package.json']);
 assert.equal(p.dependencies['@nylorun/agents'],pins.agents);assert.equal(p.dependencies['@nylorun/runtime'],pins.runtime);
 assert.equal(p.dependencies.hono,undefined);assert.equal(p.dependencies['@nylorun/harness'],undefined);
 assert.equal(files['src/index.ts'],undefined);assert.match(files['agents/assistant/agent.ts'],/lookup_order/);
 assert.equal(p.scripts.dev,enabled?'nylorun dev':'nylorun dev --no-studio');
 assert.equal(Boolean(p.devDependencies['@nylorun/studio']),enabled);assert.match(files['.gitignore'],/\.nylorun\//);
 assert.equal(p.scripts.start,'nylorun start');assert.ok(!files['agents/assistant/agent.ts'].match(/\bmodel\s*:/));
}
console.log('SDK registry starter contract passed, with and without Studio.');
