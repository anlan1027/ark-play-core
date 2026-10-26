import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createTools} from '../src/tools.mjs';
import {packageClient} from '../tools/package.mjs';

test('configured room, per-call override and solo routes use native lobby intents',async()=>{
  const r=createTools({configFile:'/tmp/nonexistent-ark-core-test-config',roomCode:'ZZ99'});
  const sent=[];
  r.client.connect=async()=>{};r.client.settle=async()=>{};r.client.view=async()=>({status:'lobby'});
  r.client.request=async message=>{sent.push(message);};
  const start=r.tools.find(t=>t.name==='ark_start');
  try {
    await start.execute(start.schema.parse({roomCode:'ab12'}));
    assert.deepEqual(sent,[{t:'room.join',code:'AB12'},{t:'room.ready',ready:true}]);
    sent.length=0;await start.execute(start.schema.parse({}));assert.equal(sent[0].code,'ZZ99');
    sent.length=0;await start.execute(start.schema.parse({roomCode:''}));
    assert.deepEqual(sent,[{t:'room.create',mode:'solo',difficulty:'ABYSS'},{t:'room.start'}]);
    assert.equal(start.schema.safeParse({roomCode:'!'}).success,false);
    sent.length=0;r.client.request=async message=>{sent.push(message);throw new Error('ROOM_NOT_FOUND');};
    await assert.rejects(start.execute(start.schema.parse({roomCode:'AB12'})),/ROOM_NOT_FOUND/);
    assert.deepEqual(sent,[{t:'room.join',code:'AB12'}]);
  }finally{await r.close();}
});

test('ZIP packaging tolerates absent optional PUBLISH and retains host/core source and public art',async()=>{
  const scratch=await mkdtemp(join(tmpdir(),'ark-core-package-test-'));
  const core=join(scratch,'core'),host=join(scratch,'host'),output=join(scratch,'out');
  async function file(root,name,content){const path=join(root,name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,content);}
  try {
    await file(core,'package.json',JSON.stringify({name:'@arkstrongholdrl/ark-play-core',version:'1.0.0'}));
    await file(core,'tools/configure.mjs','// configure');await file(core,'src/tools.mjs','// shared');
    await file(core,'PROVENANCE.md','source attribution');await file(core,'LICENSE','GPL');
    await file(host,'package.json',JSON.stringify({name:'dsh-ark-stronghold',version:'1.0.0'}));
    for(const name of ['README.md','LICENSE','configure.mjs','client.mjs','site-url.mjs','site-loader.mjs','public/art.png','dist/public/art.png','dist/index.mjs'])await file(host,name,'fixture '+name);
    const result=await packageClient({kind:'dsh',root:host,sharedRoot:core,output});
    const archive=join(output,result.filename);
    const names=execFileSync('unzip',['-Z1',archive],{encoding:'utf8'}).split('\n');
    for(const name of ['public/art.png','corresponding-source/dsh-plugin/public/art.png','corresponding-source/dsh-plugin/client.mjs','corresponding-source/ark-play-core/PROVENANCE.md'])assert.ok(names.includes('dsh-ark-stronghold/'+name),name);
    assert.equal((await readFile(archive)).length,result.bytes);
    await assert.rejects(packageClient({kind:'dsh',root:host,sharedRoot:core,output}),/Archive already exists/);
  }finally{await rm(scratch,{recursive:true,force:true});}
});

async function codexPackageFixture(t) {
  const scratch=await mkdtemp(join(tmpdir(),'ark-codex-package-test-'));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  const core=join(scratch,'core'),host=join(scratch,'host'),output=join(scratch,'out');
  const license=await readFile(new URL('../LICENSE',import.meta.url));
  const coreFiles={
    'package.json':JSON.stringify({name:'@arkstrongholdrl/ark-play-core',version:'1.0.0'}),
    'package-lock.json':JSON.stringify({name:'@arkstrongholdrl/ark-play-core',lockfileVersion:3}),
    'src/tools.mjs':'// shared source fixture\n','tools/configure.mjs':'// shared configure source\n',
    'README.md':'# Shared core fixture\n','LICENSE':license,
    'PROVENANCE.md':await readFile(new URL('../PROVENANCE.md',import.meta.url)),
  };
  const hostFiles={
    'package.json':JSON.stringify({name:'@fixture/codex-host',version:'2.3.4'}),
    'package-lock.json':JSON.stringify({name:'@fixture/codex-host',lockfileVersion:3}),
    'README.md':'# Codex host fixture\n','LICENSE':license,
    'configure.mjs':'// host-built configure entry\n',
    'plugin.json':JSON.stringify({name:'ark-play',version:'2.3.4'}),
    'mcp.json':JSON.stringify({mcpServers:{ark:{command:'node',args:['dist/index.mjs']}}}),
    '.codex-plugin/plugin.json':JSON.stringify({name:'ark-play-codex',version:'2.3.4'}),
    '.agents/plugins/marketplace.json':JSON.stringify({name:'fixture',plugins:[]}),
    'src/index.mjs':'// unbundled host source\n','client.mjs':'// host client source\n',
    'site-loader.mjs':'// host loader source\n','public/art.png':Buffer.from([0,1,2,255]),
    'dist/index.mjs':'// built Codex entry\n','dist/site-worker.mjs':'// built Worker\n',
    'dist/site-loader.mjs':'// built loader\n','dist/public/art.png':Buffer.from([3,4,5,255]),
  };
  async function files(root,entries) {
    for(const [name,bytes] of Object.entries(entries)) {
      const path=join(root,name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,bytes);
    }
  }
  await files(core,coreFiles);await files(host,hostFiles);
  return {core,host,output,coreFiles,hostFiles,files,
    pack:()=>packageClient({kind:'codex',root:host,sharedRoot:core,output})};
}
function zipEntries(archive) {
  return execFileSync('unzip',['-Z1',archive],{encoding:'utf8'}).trim().split('\n');
}
function zipBytes(archive,name) {return execFileSync('unzip',['-p',archive,name]);}

test('Codex ZIP preserves plugin layout, corresponding source, licenses and integrity records',async t=>{
  const f=await codexPackageFixture(t),record=await f.pack(),archive=join(f.output,record.filename);
  assert.equal(record.filename,'ark-play-codex-2.3.4.zip');
  execFileSync('unzip',['-tqq',archive]);
  const entries=zipEntries(archive),prefix='ark-play-codex/';
  for(const name of ['.codex-plugin/','.agents/plugins/','dist/','corresponding-source/ark-play-core/','corresponding-source/codex-plugin/'])
    assert.ok(entries.includes(prefix+name),name);
  const runtimeNames=['README.md','LICENSE','configure.mjs','plugin.json','mcp.json',
    '.codex-plugin/plugin.json','.agents/plugins/marketplace.json',...Object.keys(f.hostFiles).filter(name=>name.startsWith('dist/'))];
  // copySource retains provided source entries, not the root configure bundle
  // or dist output. No absent optional source file is required by this fixture.
  const hostSourceNames=Object.keys(f.hostFiles).filter(name=>name!=='configure.mjs'&&!name.startsWith('dist/'));
  const expected=Object.fromEntries([
    ...runtimeNames.map(name=>[name,f.hostFiles[name]]),
    ...Object.entries(f.coreFiles).map(([name,bytes])=>['corresponding-source/ark-play-core/'+name,bytes]),
    ...hostSourceNames.map(name=>['corresponding-source/codex-plugin/'+name,f.hostFiles[name]]),
  ]);
  assert.deepEqual(entries.filter(name=>!name.endsWith('/')).sort(),Object.keys(expected).map(name=>prefix+name).sort());
  for(const [name,bytes] of Object.entries(expected))assert.deepEqual(zipBytes(archive,prefix+name),Buffer.from(bytes),name);
  assert.equal(entries.some(name=>name.endsWith('/PUBLISH.md')),false);
  const bytes=await readFile(archive),sha256=createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(record,{filename:'ark-play-codex-2.3.4.zip',bytes:bytes.length,sha256});
  assert.equal(await readFile(archive+'.sha256','utf8'),sha256+'  '+record.filename+'\n');
  assert.deepEqual(JSON.parse(await readFile(archive+'.json','utf8')),record);
  assert.deepEqual((await readdir(f.output)).sort(),[record.filename,record.filename+'.json',record.filename+'.sha256'].sort());
});

test('Codex repeat packaging rejects the same path and preserves the ZIP and both records',async t=>{
  const f=await codexPackageFixture(t),record=await f.pack(),archive=join(f.output,record.filename);
  const paths=[archive,archive+'.sha256',archive+'.json'];
  const before=await Promise.all(paths.map(path=>readFile(path)));
  await writeFile(join(f.host,'dist/index.mjs'),'// changed host build that must not replace the archive\n');
  await assert.rejects(f.pack(),{message:'Archive already exists: '+archive});
  for(let i=0;i<paths.length;i++)assert.deepEqual(await readFile(paths[i]),before[i],paths[i]);
  assert.deepEqual((await readdir(f.output)).sort(),paths.map(path=>path.split('/').at(-1)).sort());
  execFileSync('unzip',['-tqq',archive]);
});

for(const missing of ['plugin.json','mcp.json','.codex-plugin','.agents/plugins/marketplace.json','dist'])
test('Codex packaging rejects missing required input without publishing a partial archive: '+missing,async t=>{
  const f=await codexPackageFixture(t);await rm(join(f.host,missing),{recursive:true});
  await assert.rejects(f.pack(),error=>{
    assert.equal(error.code,'ENOENT');assert.equal(error.path,join(f.host,missing));return true;
  });
  assert.deepEqual(await readdir(f.output),[]);
});

test('Codex packaging includes optional PUBLISH when provided',async t=>{
  const f=await codexPackageFixture(t),text='Fixture publishing instructions\n';
  await writeFile(join(f.host,'PUBLISH.md'),text);
  const record=await f.pack(),archive=join(f.output,record.filename);
  for(const name of ['PUBLISH.md','corresponding-source/codex-plugin/PUBLISH.md'])
    assert.equal(zipBytes(archive,'ark-play-codex/'+name).toString(),text);
});

test('Codex and DSH packages keep distinct build and corresponding-source layouts',async t=>{
  const f=await codexPackageFixture(t),dsh=join(f.host,'..','dsh');
  await f.files(dsh,{
    'package.json':JSON.stringify({name:'@fixture/dsh-host',version:'2.3.4'}),
    'README.md':'# DSH fixture\n','LICENSE':f.hostFiles.LICENSE,'configure.mjs':'// DSH configure\n',
    'client.mjs':'// DSH source\n','dist/index.mjs':'// DSH build\n','dist/public/art.png':Buffer.from([6,7,8,255]),
  });
  const codex=await f.pack();
  const dshRecord=await packageClient({kind:'dsh',root:dsh,sharedRoot:f.core,output:f.output});
  assert.equal(dshRecord.filename,'fixture-dsh-host-2.3.4.zip');
  const codexEntries=zipEntries(join(f.output,codex.filename)),dshArchive=join(f.output,dshRecord.filename);
  const dshEntries=zipEntries(dshArchive),codexPrefix='ark-play-codex/',dshPrefix='fixture-dsh-host/';
  assert.ok(codexEntries.every(name=>name.startsWith(codexPrefix)));assert.ok(dshEntries.every(name=>name.startsWith(dshPrefix)));
  for(const name of ['dist/index.mjs','dist/public/art.png','corresponding-source/codex-plugin/client.mjs'])
    assert.ok(codexEntries.includes(codexPrefix+name),name);
  for(const name of ['index.mjs','public/art.png','corresponding-source/dsh-plugin/client.mjs'])
    assert.ok(dshEntries.includes(dshPrefix+name),name);
  for(const name of ['index.mjs','public/art.png','corresponding-source/dsh-plugin/'])assert.equal(codexEntries.includes(codexPrefix+name),false,name);
  for(const name of ['dist/','plugin.json','mcp.json','.codex-plugin/','.agents/','corresponding-source/codex-plugin/'])
    assert.equal(dshEntries.includes(dshPrefix+name),false,name);
  assert.equal(zipBytes(dshArchive,dshPrefix+'index.mjs').toString(),'// DSH build\n');
  execFileSync('unzip',['-tqq',dshArchive]);
});
