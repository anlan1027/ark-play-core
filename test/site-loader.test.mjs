import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function http(t,handle) {
  const requests=[],server=createServer((req,res)=>{requests.push(req.url);handle(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {origin:'http://127.0.0.1:'+server.address().port,requests};
}

// Each test owns a separate module instance and fetch state in a real Worker.
// The RPC also lets a test inspect a pending prefetch without releasing HTTP.
const runner=`
import {parentPort,workerData} from 'node:worker_threads';
import {register} from 'node:module';
const hooks=await import(workerData.loader);
const nativeFetch=globalThis.fetch;let active=0,peak=0,calls=0,timeoutController;
const timeouts=[];
globalThis.fetch=async(...args)=>{
  calls++;active++;peak=Math.max(peak,active);
  try{return await nativeFetch(...args);}finally{active--;}
};
parentPort.on('message',async q=>{
  try {
    let result;
    if(q.op==='initialize')result=await hooks.initialize(q.options);
    else if(q.op==='resolve')result=await hooks.resolve(q.url,{parentURL:q.parent},(url,context)=>({delegated:true,url,parent:context.parentURL}));
    else if(q.op==='load')result=await hooks.load(q.url,{},()=>({delegated:true}));
    else if(q.op==='stats')result={active,peak,calls,timeouts};
    else if(q.op==='armTimeout') {
      timeoutController=new AbortController();
      AbortSignal.timeout=ms=>{timeouts.push(ms);return timeoutController.signal;};
    }else if(q.op==='abortTimeout')timeoutController.abort(new DOMException('fixture timeout','TimeoutError'));
    else if(q.op==='import') {
      register(workerData.loader,{parentURL:import.meta.url,data:q.options});
      result={...await import(q.url)};
    }else throw new Error('Unknown fixture operation');
    parentPort.postMessage({id:q.id,result});
  }catch(error){parentPort.postMessage({id:q.id,error:{name:error.name,message:error.message}});}
});
parentPort.postMessage({ready:true});
`;
async function loader(t) {
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(runner)),{
    workerData:{loader:new URL('../src/site-loader.mjs',import.meta.url).href},
  });
  const ready=Promise.withResolvers(),pending=new Map();let counter=0;
  const fail=error=>{ready.reject(error);for(const p of pending.values())p.reject(error);pending.clear();};
  worker.on('error',fail);worker.on('exit',code=>fail(new Error('Fixture Worker exited: '+code)));
  worker.on('message',message=>{
    if(message.ready)return ready.resolve();
    const p=pending.get(message.id);if(!p)return;pending.delete(message.id);
    if(message.error)p.reject(Object.assign(new Error(message.error.message),{name:message.error.name}));else p.resolve(message.result);
  });
  t.after(()=>worker.terminate());await ready.promise;
  return (op,fields={})=>new Promise((resolve,reject)=>{
    const id=++counter;pending.set(id,{resolve,reject});worker.postMessage({op,id,...fields});
  });
}

test('pinned modules are hash-verified, carry headers, and remain cached in memory',{timeout:10_000},async t=>{
  const source='export const value=42;';let bytes=source,header;
  const s=await http(t,(req,res)=>{header=req.headers['x-fixture'];res.end(bytes);}),ask=await loader(t);
  await ask('initialize',{options:{origin:s.origin,headers:{'X-Fixture':'local'},hashes:{'sim/value.js':sha(source)}}});
  assert.deepEqual(await ask('resolve',{url:'./value.js',parent:s.origin+'/sim/main.js'}),{url:s.origin+'/sim/value.js',shortCircuit:true});
  bytes='corrupted after prefetch';
  for(let i=0;i<2;i++) {
    const result=await ask('load',{url:s.origin+'/sim/value.js'});
    assert.equal(result.format,'module');assert.equal(result.shortCircuit,true);assert.equal(Buffer.from(result.source).toString(),source);
  }
  assert.equal(header,'local');assert.deepEqual(s.requests,['/sim/value.js']);
});
test('pinned module hash mismatch rejects prefetch',{timeout:10_000},async t=>{
  const s=await http(t,(_,res)=>res.end('export const value=0;')),ask=await loader(t);
  await assert.rejects(ask('initialize',{options:{origin:s.origin,headers:{},hashes:{'sim/value.js':sha('export const value=42;')}}}),/Upstream module hash mismatch: \/sim\/value.js/);
});
test('cross-site imports and loads are refused without contacting the other site',{timeout:10_000},async t=>{
  const s=await http(t,(_,res)=>res.end('')),other=await http(t,(_,res)=>res.end('')),ask=await loader(t);
  await ask('initialize',{options:{origin:s.origin,headers:{},hashes:{}}});
  await assert.rejects(ask('resolve',{url:other.origin+'/sim/module.js',parent:s.origin+'/sim/main.js'}),/Cross-site module import refused/);
  await assert.rejects(ask('load',{url:other.origin+'/sim/module.js'}),/Cross-site module load refused/);
  assert.deepEqual(other.requests,[]);assert.deepEqual(s.requests,[]);
});
for(const path of ['/sim/value.js','sim/../value.js','sim/%2e%2e/value.js','sim/value.js?changed=1','sim/value.js#fragment','node:fs'])test('invalid manifest module path is rejected before HTTP: '+path,{timeout:10_000},async t=>{
  const s=await http(t,(_,res)=>res.end('')),ask=await loader(t);
  await assert.rejects(ask('initialize',{options:{origin:s.origin,headers:{},hashes:{[path]:sha('')}}}),/Invalid upstream manifest module path/);
  assert.deepEqual(s.requests,[]);
});
test('unlisted dependencies, credentials, fragments and builtins are refused from remote parents',{timeout:10_000},async t=>{
  const s=await http(t,(_,res)=>res.end('')),ask=await loader(t);
  await ask('initialize',{options:{origin:s.origin,headers:{},hashes:{}}});
  for(const url of ['./unlisted.js','/js/ui/admin.js','/sim/unlisted.js'])
    await assert.rejects(ask('resolve',{url,parent:s.origin+'/sim/main.js'}),/Unsupported upstream client dependency/);
  for(const url of [s.origin.replace('://','://user@')+'/js/ui/facing.js',s.origin+'/js/ui/facing.js#fragment','node:fs'])
    await assert.rejects(ask('resolve',{url,parent:s.origin+'/sim/main.js'}),/Cross-site module import refused/);
  assert.deepEqual(s.requests,[]);
});
test('existing unpinned UI exceptions still resolve and load, including query strings',{timeout:10_000},async t=>{
  const source='export const ui=true;',s=await http(t,(_,res)=>res.end(source)),ask=await loader(t);
  await ask('initialize',{options:{origin:s.origin,headers:{},hashes:{}}});
  for(const path of ['js/ui/gameLogic/layout.js','js/ui/facing.js','js/render/prepfield.js?fixture=1']) {
    const url=s.origin+'/'+path;
    assert.deepEqual(await ask('resolve',{url,parent:s.origin+'/sim/main.js'}),{url,shortCircuit:true});
    assert.equal(Buffer.from((await ask('load',{url})).source).toString(),source);
  }
  assert.equal(s.requests.length,3);
});
test('non-remote module resolution and loading delegate to Node',{timeout:10_000},async t=>{
  const ask=await loader(t);
  assert.deepEqual(await ask('resolve',{url:'node:crypto',parent:'file:///fixture.mjs'}),{delegated:true,url:'node:crypto',parent:'file:///fixture.mjs'});
  assert.deepEqual(await ask('load',{url:'file:///fixture.mjs'}),{delegated:true});
});
test('module HTTP failures and redirects propagate without following a redirect',{timeout:10_000},async t=>{
  const other=await http(t,(_,res)=>res.end('must not fetch'));
  const s=await http(t,(req,res)=>{
    if(req.url==='/js/ui/gameLogic/redirect.js'){res.writeHead(302,{Location:other.origin+'/target'});res.end();}
    else {res.writeHead(404);res.end();}
  }),ask=await loader(t);
  await ask('initialize',{options:{origin:s.origin,headers:{},hashes:{}}});
  await assert.rejects(ask('load',{url:s.origin+'/js/ui/gameLogic/missing.js'}),/Upstream module unavailable: .* HTTP 404/);
  await assert.rejects(ask('load',{url:s.origin+'/js/ui/gameLogic/redirect.js'}),{name:'TypeError'});
  assert.deepEqual(other.requests,[]);
});
test('module prefetch rejects responses above the existing 3 MiB limit',{timeout:10_000},async t=>{
  const bytes=Buffer.alloc(3*1024*1024+1),s=await http(t,(_,res)=>res.end(bytes)),ask=await loader(t);
  await assert.rejects(ask('initialize',{options:{origin:s.origin,headers:{},hashes:{'sim/large.js':sha(bytes)}}}),/Upstream module too large/);
});
test('module prefetch propagates timeout cancellation without waiting 30 seconds',{timeout:10_000},async t=>{
  const arrived=Promise.withResolvers(),s=await http(t,()=>arrived.resolve()),ask=await loader(t);
  await ask('armTimeout');
  const rejected=assert.rejects(ask('initialize',{options:{origin:s.origin,headers:{},hashes:{'sim/pending.js':sha('')}}}),{name:'TimeoutError'});
  await arrived.promise;await ask('abortTimeout');await rejected;
  assert.deepEqual((await ask('stats')).timeouts,[30_000]);
});
test('manifest prefetch starts at most eight requests and finishes all modules',{timeout:10_000},async t=>{
  const batch=Promise.withResolvers(),release=Promise.withResolvers(),source='export {};';
  let active=0,peak=0;
  const s=await http(t,(_,res)=>{
    active++;peak=Math.max(peak,active);if(active===8)batch.resolve();
    release.promise.then(()=>{active--;res.end(source);});
  }),ask=await loader(t);
  const hashes=Object.fromEntries(Array.from({length:20},(_,i)=>['sim/module'+i+'.js',sha(source)]));
  const initializing=ask('initialize',{options:{origin:s.origin,headers:{},hashes}});
  // Keep all first-batch responses pending while inspecting the Worker. Merely
  // releasing after the eighth HTTP arrival could conceal excess queued fetches.
  try {
    await batch.promise;const stats=await ask('stats');
    assert.equal(stats.calls,8);assert.equal(stats.active,8);assert.equal(stats.peak,8);
    assert.equal(s.requests.length,8);assert.equal(active,8);
  }finally{release.resolve();await initializing;}
  assert.equal(s.requests.length,20);assert.equal(new Set(s.requests).size,20);assert.ok(peak<=8);
  assert.ok((await ask('stats')).peak<=8);
});
test('Node registered hooks execute pinned and allowed unpinned ESM dependencies inside a Worker',{timeout:10_000},async t=>{
  const modules={
    '/sim/main.js':"import {value} from './dep.js';import {extra} from '../js/ui/gameLogic/value.js';export const answer=value+extra;",
    '/sim/dep.js':'export const value=40;',
    '/js/ui/gameLogic/value.js':'export const extra=2;',
  };
  const s=await http(t,(req,res)=>{
    if(modules[req.url])res.end(modules[req.url]);else {res.writeHead(404);res.end();}
  }),ask=await loader(t);
  const hashes=Object.fromEntries(['/sim/main.js','/sim/dep.js'].map(path=>[path.slice(1),sha(modules[path])]));
  assert.deepEqual(await ask('import',{url:s.origin+'/sim/main.js',options:{origin:s.origin,headers:{},hashes}}),{answer:42});
  assert.equal(s.requests.length,3);assert.deepEqual(new Set(s.requests),new Set(Object.keys(modules)));
});
