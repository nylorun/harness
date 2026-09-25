import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {starterFiles} from '../dist/scaffold.js';
const pins=JSON.parse(await readFile(new URL('../compatibility.json',import.meta.url),'utf8'));
for(const enabled of [true,false]){
 const files=await starterFiles(pins,enabled);const p=JSON.parse(files['package.json']);
 assert.equal(p.dependencies['@nylorun/agents'],pins.agents);assert.equal(p.dependencies['@nylorun/cli'],undefined);assert.equal(p.devDependencies['@nylorun/cli'],pins.cli);
 assert.equal(p.dependencies['@nylorun/runtime'],undefined);
 assert.equal(p.dependencies.hono,undefined);assert.equal(p.dependencies['@nylorun/harness'],undefined);
 assert.equal(files['src/index.ts'],undefined);assert.ok(files['src/main.ts']);assert.match(files['agents/assistant/agent.ts'],/lookup_order/);
 assert.equal(p.scripts.dev,'nylorun dev');
 assert.equal(Boolean(p.devDependencies['@nylorun/studio']),enabled);assert.match(files['.gitignore'],/\.nylorun\//);
 assert.equal(p.scripts.start,'node dist/src/main.js');
 assert.equal(p.scripts.studio,enabled?'nylorun-studio':undefined);
 assert.ok(!files['agents/assistant/agent.ts'].match(/\bmodel\s*:/));
 // Admin is for CLI/desktop/CI — starter apps must not depend on it.
 assert.equal(p.dependencies['@nylorun/admin'],undefined);
 assert.equal(p.devDependencies?.['@nylorun/admin'],undefined);
 assert.match(pins.admin,/^\d+\.\d+\.\d+-beta$/);
}
console.log('SDK registry starter contract passed, with and without Studio.');
