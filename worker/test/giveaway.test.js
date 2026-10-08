import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {readFile} from 'node:fs/promises';
const ORIGIN='http://localhost:8080';
const TOKEN='test1919';
async function setup(t,extra={}){
  const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
  const fixture=`import worker,{Giveaway} from './production.js';
    export class TestGiveaway extends Giveaway {
      async fetch(request){if(new URL(request.url).pathname==='/__test/elapsed'){
        await this.ctx.storage.transaction(async txn=>{const state=await txn.get('state');state.nextAt=Date.now()-1;await txn.put('state',state);});
        return new Response('{}');
      }return super.fetch(request);}
    }
    export default {fetch(request,env){if(new URL(request.url).pathname==='/__test/elapsed')return env.GIVEAWAY.get(env.GIVEAWAY.idFromName('main')).fetch(request);return worker.fetch(request,env);}};`;
  const mf=new Miniflare({workers:[{name:'taka',modules:[{type:'ESModule',path:'test-entry.js',contents:fixture},{type:'ESModule',path:'production.js',contents:source}],compatibilityDate:'2026-10-01',
    durableObjects:{GIVEAWAY:{className:'TestGiveaway',useSQLite:true}},
    bindings:{ALLOWED_ORIGINS:ORIGIN,ADMIN_TOKEN:TOKEN,DEV_MODE:'true',...extra}}]});
  t.after(()=>mf.dispose());
  async function call(path,body,options={}){
    const response=await mf.dispatchFetch('http://worker'+path,{method:body?'POST':'GET',headers:{Origin:ORIGIN,'Content-Type':'application/json',...(path.startsWith('/api/admin')?{Authorization:'Bearer '+TOKEN}:{}),...options.headers},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json(),headers:response.headers};
  }
  return {mf,call};
}
test('公開APIにリンクを漏らさず、同時20件は1件だけ受け取り、30分を保持する',async t=>{
  const {call}=await setup(t);
  await call('/api/admin/add',{title:'テストアイテム',description:'ひとこと',links:['https://example.com/secret-one','https://example.com/secret-two']});
  const before=await call('/api/status');assert.equal(before.data.state,'available');assert.ok(!JSON.stringify(before.data).includes('secret'));
  const keys=Array.from({length:20},()=>crypto.randomUUID());
  const results=await Promise.all(keys.map(claimKey=>call('/api/claim',{claimKey})));
  assert.equal(results.filter(x=>x.status===200).length,1);
  const winner=results.findIndex(x=>x.status===200);assert.equal(results[winner].data.url,'https://example.com/secret-one');
  const after=await call('/api/status');assert.equal(after.data.state,'waiting');
  assert.ok(after.data.nextAt-after.data.serverTime>1790000&&after.data.nextAt-after.data.serverTime<=1800000);
  const admin=await call('/api/admin');assert.equal(admin.data.queue.length,1);assert.equal(admin.data.claimed,1);assert.ok(!JSON.stringify(admin.data).includes('secret'));
  // GETとPOSTのレートを分離。新しいIPで回復操作を確認。
  const recovered=await call('/api/recover',{claimKey:keys[winner]},{headers:{'CF-Connecting-IP':'192.0.2.10'}});
  assert.equal(recovered.data.url,'https://example.com/secret-one');
  const repeated=await call('/api/claim',{claimKey:keys[winner]},{headers:{'CF-Connecting-IP':'192.0.2.11'}});assert.equal(repeated.data.url,recovered.data.url);
  const stranger=await call('/api/recover',{claimKey:crypto.randomUUID()},{headers:{'CF-Connecting-IP':'192.0.2.12'}});assert.equal(stranger.data.url,null);
});
test('管理キー・Origin・本人確認が必要。javascript URLと重複を拒否する',async t=>{
  const {call}=await setup(t);
  assert.equal((await call('/api/admin',undefined,{headers:{Authorization:'Bearer wrong'}})).status,401);
  assert.equal((await call('/api/admin/add',{title:'x',links:['https://example.com/a']},{headers:{Origin:'https://evil.example'}})).status,403);
  const invalid=await call('/api/admin/add',{title:'x',links:['https://example.com/a','javascript:alert(1)']});assert.equal(invalid.status,400);
  assert.equal((await call('/api/admin')).data.queue.length,0);
  const added=await call('/api/admin/add',{title:'x',links:['https://example.com/a','https://example.com/a']});assert.deepEqual(added.data,{added:1,skipped:1});
  assert.equal((await call('/api/claim',{claimKey:'guess'})).status,400);
  const {call:production}=await setup(t,{DEV_MODE:'false'});
  await production('/api/admin/add',{title:'x',links:['https://example.com/a']});
  assert.equal((await production('/api/claim',{claimKey:crypto.randomUUID(),turnstileToken:'forged'})).status,403);
  assert.equal((await production('/api/status')).data.state,'available');
});
test('停止と再開、削除、設定保存、30分後の補充と空在庫',async t=>{
  const {call,mf}=await setup(t);
  await call('/api/admin/add',{title:'x',links:['https://example.com/a','https://example.com/b']});
  await call('/api/admin/settings',{paused:true});assert.equal((await call('/api/status')).data.state,'paused');
  assert.equal((await call('/api/claim',{claimKey:crypto.randomUUID()})).status,409);
  await call('/api/admin/settings',{paused:false,intervalMinutes:30});
  await call('/api/claim',{claimKey:crypto.randomUUID()});
  await mf.dispatchFetch('http://worker/__test/elapsed');
  assert.equal((await call('/api/status')).data.state,'available');
  await call('/api/claim',{claimKey:crypto.randomUUID()});
  await mf.dispatchFetch('http://worker/__test/elapsed');
  assert.equal((await call('/api/status')).data.state,'empty');
  // 使用済みリンクを再追加しても配布しない。
  assert.deepEqual((await call('/api/admin/add',{title:'x',links:['https://example.com/a']})).data,{added:0,skipped:1});
  await call('/api/admin/add',{title:'y',links:['https://example.com/c']});const queue=(await call('/api/admin')).data.queue;
  await call('/api/admin/delete',{id:queue[0].id});assert.equal((await call('/api/admin')).data.queue.length,0);
  assert.equal((await call('/api/admin/settings',{intervalMinutes:0})).status,400);
});
