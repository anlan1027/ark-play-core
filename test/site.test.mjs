import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import workerThreads from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import {readSite,SiteRuntime} from '../src/site.mjs';

const cs='a'.repeat(64),sim='b'.repeat(64),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const tables=['chess','enemies','tokens','stages','waves','bonds','items','garrisons','bands','effects','backups','bosses'];
async function http(t,handle) {
  const requests=[],server=createServer((req,res)=>{requests.push(req.url);handle(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {origin:'http://127.0.0.1:'+server.address().port,requests};
}
async function content(t) {
  const files=new Map(),raw={};
  const index={v:1,cs,sim,app:'0.3.1',vanilla:true,plugins:[],settings:{},simFiles:{},data:{}};
  for(const key of tables) {
    raw[key]={fixture:{name:'测试 '+key}};
    const bytes=Buffer.from(JSON.stringify(raw[key])),url='/data/'+key+'.json';
    files.set(url,bytes);index.data[key]={url,bytes:bytes.length,sha256:sha(bytes)};
  }
  const site=await http(t,(req,res)=>{
    if(req.url==='/cs/'+cs.slice(0,16)+'/index.json')return res.end(JSON.stringify(index));
    const bytes=files.get(req.url);
    if(bytes)return res.end(bytes);
    res.writeHead(404);res.end();
  });
  const failures=[],runtime=new SiteRuntime(site.origin,{},()=>{},error=>failures.push(error));
  t.after(()=>runtime.close());
  return {...site,index,files,raw,runtime,failures};
}

test('readSite reads exact UTF-8 bytes and forwards configured headers',{timeout:10_000},async t=>{
  const bytes=Buffer.from('{"name":"测试"}');let header;
  const s=await http(t,(req,res)=>{header=req.headers['x-fixture'];res.end(bytes);});
  assert.deepEqual(await readSite(s.origin+'/data',{'X-Fixture':'local'},bytes.length),bytes);
  assert.equal(header,'local');assert.deepEqual(s.requests,['/data']);
});
test('readSite rejects unsuccessful HTTP status',{timeout:10_000},async t=>{
  const s=await http(t,(_,res)=>{res.writeHead(503);res.end('unavailable');});
  await assert.rejects(readSite(s.origin+'/unavailable',{}),/Site content HTTP 503 at \/unavailable/);
});
test('readSite refuses redirects without following their destination',{timeout:10_000},async t=>{
  const target=await http(t,(_,res)=>res.end('must not read'));
  const s=await http(t,(_,res)=>{res.writeHead(302,{Location:target.origin+'/target'});res.end();});
  await assert.rejects(readSite(s.origin+'/redirect',{}),TypeError);
  assert.deepEqual(target.requests,[]);assert.deepEqual(s.requests,['/redirect']);
});
test('readSite enforces a byte bound even for chunked responses',{timeout:10_000},async t=>{
  const s=await http(t,(_,res)=>{res.write('1234');res.end('5');});
  await assert.rejects(readSite(s.origin+'/large',{},4),/Site content size bound exceeded/);
});
test('readSite enforces its default 16 MiB bound',{timeout:10_000},async t=>{
  const s=await http(t,(_,res)=>res.end(Buffer.alloc(16*1024*1024+1)));
  await assert.rejects(readSite(s.origin+'/large',{}),/Site content size bound exceeded/);
});
test('readSite propagates its 30-second timeout signal without a real timeout wait',{timeout:10_000},async t=>{
  const arrived=Promise.withResolvers(),controller=new AbortController(),timeouts=[];
  const s=await http(t,()=>arrived.resolve());
  t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return controller.signal;});
  const read=readSite(s.origin+'/pending',{});
  const rejected=assert.rejects(read,{name:'TimeoutError'});
  await arrived.promise;controller.abort(new DOMException('fixture timeout','TimeoutError'));
  await rejected;assert.deepEqual(timeouts,[30_000]);
});
test('readSite rejects an interrupted response body',{timeout:10_000},async t=>{
  const written=Promise.withResolvers();
  const s=await http(t,(_,res)=>{
    res.writeHead(200,{'Content-Length':100});res.write('partial',()=>written.resolve(res));
  });
  const rejected=assert.rejects(readSite(s.origin+'/interrupted',{}),TypeError);
  (await written.promise).destroy();await rejected;
});

test('valid data reaches the Worker boundary but load waits for an explicit ready message',{timeout:10_000},async t=>{
  const s=await content(t),created=Promise.withResolvers();
  const replacement=t.mock.method(workerThreads,'Worker',function(url,options){
    const worker=new EventEmitter();worker.terminated=false;
    worker.postMessage=message=>queueMicrotask(()=>worker.emit('message',{type:'reply',id:message.id,result:'fixture reply'}));
    worker.terminate=async()=>{worker.terminated=true;return 0;};
    created.resolve({worker,url,options});return worker;
  });
  syncBuiltinESMExports();t.after(()=>{replacement.mock.restore();syncBuiltinESMExports();});
  let settled=false;const loading=s.runtime.load(cs);loading.then(()=>settled=true,()=>settled=true);
  const {worker,url,options}=await created.promise;
  const ready={type:'ready',app:'0.3.1',protocol:1,content:cs};
  try {
    assert.equal(url.href,new URL('../src/site-worker.mjs',import.meta.url).href);
    assert.deepEqual(options.workerData,{origin:s.origin,headers:{},index:s.index,raw:s.raw});
    assert.deepEqual(s.runtime.raw,s.raw);assert.equal(settled,false);assert.equal(s.runtime.ready,undefined);
    assert.equal(s.requests.length,13);
  }finally{worker.emit('message',ready);await loading;}
  assert.deepEqual(s.runtime.ready,ready);
  assert.equal(await s.runtime.request('map',{}),'fixture reply');
  await s.runtime.close();assert.equal(worker.terminated,true);assert.equal(s.runtime.worker,null);
});

for(const identity of ['',cs.slice(1),'A'.repeat(64),'z'.repeat(64)])test('invalid content identity is rejected before HTTP: '+JSON.stringify(identity),{timeout:10_000},async t=>{
  const s=await content(t);
  await assert.rejects(s.runtime.load(identity),/supported content identity/);
  assert.deepEqual(s.requests,[]);assert.equal(s.runtime.worker,undefined);
});
for(const [name,change] of [
  ['version',index=>index.v=2],['identity mismatch',index=>index.cs='c'.repeat(64)],
  ['non-vanilla content',index=>index.vanilla=false],['plugins',index=>index.plugins=['fixture']],
  ['missing modules',index=>delete index.simFiles],['missing data',index=>delete index.data],
])test('unsupported manifest is rejected before data/Worker loading: '+name,{timeout:10_000},async t=>{
  const s=await content(t);change(s.index);
  await assert.rejects(s.runtime.load(cs),/Only the site vanilla content protocol v1/);
  assert.deepEqual(s.requests,['/cs/'+cs.slice(0,16)+'/index.json']);assert.equal(s.runtime.worker,undefined);
});
for(const [name,change,error] of [
  ['hash mismatch',s=>s.index.data.chess.sha256='0'.repeat(64),/hash\/size mismatch: chess/],
  ['size mismatch',s=>s.index.data.chess.bytes++,/hash\/size mismatch: chess/],
  ['missing table',s=>delete s.index.data.chess,/Site data missing: chess/],
  ['invalid JSON with matching bytes and hash',s=>{
    const bytes=Buffer.from('{broken');s.files.set('/data/chess.json',bytes);
    Object.assign(s.index.data.chess,{bytes:bytes.length,sha256:sha(bytes)});
  },SyntaxError],
])test('data fails before Worker creation: '+name,{timeout:10_000},async t=>{
  const s=await content(t);change(s);
  await assert.rejects(s.runtime.load(cs),error);assert.equal(s.runtime.worker,undefined);
});
test('data from another origin is rejected without contacting that origin',{timeout:10_000},async t=>{
  const target=await http(t,(_,res)=>res.end('{}')),s=await content(t);
  s.index.data.chess.url=target.origin+'/data/chess.json';
  await assert.rejects(s.runtime.load(cs),/Unsupported site data URL/);
  assert.deepEqual(target.requests,[]);assert.equal(s.runtime.worker,undefined);
});
for(const path of ['/private/chess.json','/data/chess.js','/data/sub/chess.json','/data/%2e%2e/private.json'])test('unexpected data path is rejected before it is requested: '+path,{timeout:10_000},async t=>{
  const s=await content(t);s.index.data.chess.url=path;
  await assert.rejects(s.runtime.load(cs),/Unsupported site data URL/);
  assert.equal(s.requests.includes(path),false);assert.equal(s.runtime.worker,undefined);
});

// These modules only reach the real Worker's identity/version guards. They do
// not implement a simulator and must never be used as a successful engine.
function guardModules(s,{protocol=1,app='0.3.1',contentIdentity=cs}={}) {
  const modules={
    'shared/plugins/identity.js':`export const simHashOf=()=>${JSON.stringify(sim)},contentHashOf=()=>${JSON.stringify(contentIdentity)};`,
    'shared/constants.js':`export const PROTOCOL_VERSION=${protocol},APP_VERSION=${JSON.stringify(app)};`,
    'shared/protocol.js':'export {};','sim/simdata.js':'export {};','sim/spec.js':'export {};',
    'sim/content/support/index.js':'export {};','shared/plugins/officialBounds.js':'export {};',
    'js/ui/gameLogic/placement.js':'export {};','js/ui/gameLogic/camera.js':'export {};',
  };
  for(const [path,source] of Object.entries(modules)) {
    const bytes=Buffer.from(source);s.files.set('/'+path,bytes);s.index.simFiles[path]=sha(bytes);
  }
}
for(const [name,options,error] of [
  ['protocol',{protocol:2},/Unsupported upstream protocol\/application version/],
  ['unsupported app',{app:'9.0.0'},/Unsupported upstream protocol\/application version/],
  ['app differs from manifest',{app:'0.3.0'},/Unsupported upstream protocol\/application version/],
  ['content identity',{contentIdentity:'c'.repeat(64)},/Upstream content identity mismatch/],
])test('real Worker rejects '+name+' before simulation initialization',{timeout:10_000},async t=>{
  const s=await content(t);guardModules(s,options);
  await assert.rejects(s.runtime.load(cs),error);
  assert.ok(s.runtime.worker);assert.equal(s.runtime.ready,undefined);
  assert.ok(s.failures.some(message=>error.test(message)));
});
