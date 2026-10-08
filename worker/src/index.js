const DAY = 86400000;
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
const fail = (error, status=400) => json({error},status);
export async function digest(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join(''); }
async function authenticate(request, env) {
  const candidate = request.headers.get('Authorization')?.replace(/^Bearer /,'') || '';
  if(!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length<8 || !candidate || candidate.length>512) return false;
  const a=await digest(candidate),b=await digest(env.ADMIN_TOKEN);let diff=0;
  for(let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
export function validLink(value) {
  if(typeof value!=='string'||value.length>2048) throw new Error('リンクは2048文字以内にしてください。');
  let url;try{url=new URL(value);}catch{throw new Error('正しいURLを入力してください。');}
  if(url.protocol!=='https:'||url.username||url.password) throw new Error('https のリンクを入力してください。');
  return url.href;
}
async function readBody(request) {
  if(!request.headers.get('Content-Type')?.includes('application/json')) throw new Error('JSONで送信してください。');
  const reader=request.body?.getReader(); if(!reader) throw new Error('入力がありません。');
  let size=0;const chunks=[];
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>250000){await reader.cancel();throw new Error('入力が大きすぎます。');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error('入力形式が正しくありません。');}
  if(!body||typeof body!=='object'||Array.isArray(body)) throw new Error('入力形式が正しくありません。');
  return body;
}
function validKey(key){return typeof key==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key);}
async function verify(request,env,body,origin){
  if(env.DEV_MODE==='true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  if(!env.TURNSTILE_SECRET||!env.TURNSTILE_HOSTNAMES) return false;
  if(typeof body.turnstileToken!=='string'||body.turnstileToken.length>2048) return false;
  const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
    method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),
    body:JSON.stringify({secret:env.TURNSTILE_SECRET,response:body.turnstileToken,remoteip:request.headers.get('CF-Connecting-IP')||undefined}),
  });
  const result=await response.json();
  return result.success===true && result.action==='claim' && env.TURNSTILE_HOSTNAMES.split(',').map(x=>x.trim()).includes(result.hostname);
}
export default {
  async fetch(request,env){
    const origin=request.headers.get('Origin')||'';
    const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
    function wrap(response){
      const headers=new Headers(response.headers);headers.set('Vary','Origin');
      if(allowed.includes(origin)){headers.set('Access-Control-Allow-Origin',origin);headers.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');headers.set('Access-Control-Allow-Headers','Content-Type, Authorization');headers.set('Access-Control-Max-Age','600');}
      return new Response(response.body,{status:response.status,headers});
    }
    try{
      if(origin&&!allowed.includes(origin)) return wrap(fail('このサイトからは利用できません。',403));
      if(request.method==='OPTIONS') return wrap(new Response(null,{status:204}));
      const path=new URL(request.url).pathname;
      const admin=path==='/api/admin'||path.startsWith('/api/admin/');
      const routes=new Map([['/api/status','GET'],['/api/claim','POST'],['/api/recover','POST'],['/api/admin','GET'],['/api/admin/add','POST'],['/api/admin/delete','POST'],['/api/admin/settings','POST']]);
      if(!routes.has(path))return wrap(fail('見つかりません。',404));
      if(routes.get(path)!==request.method)return wrap(fail('この操作は利用できません。',405));
      if(request.method==='POST'&&!allowed.includes(origin))return wrap(fail('許可されたページから操作してください。',403));
      const object=env.GIVEAWAY.get(env.GIVEAWAY.idFromName('main'));
      const authenticated=admin&&await authenticate(request,env);
      // 全処理を同じ Durable Object に集める。IPは秘密キーを混ぜたハッシュのみ保存。
      const ipHash=await digest(`${env.ADMIN_TOKEN||''}:${request.headers.get('CF-Connecting-IP')||'local'}`);
      const limited=await object.fetch(new Request('https://internal/limit',{method:'POST',body:JSON.stringify({key:ipHash+':'+(admin?(authenticated?'admin':'admin-login'):request.method),limit:admin?(authenticated?60:10):request.method==='GET'?120:20})}));
      if(!limited.ok)return wrap(fail('アクセスが多いため、少し待ってからお試しください。',429));
      if(admin&&!authenticated)return wrap(fail('パスワードが正しくありません。',401));
      const body=request.method==='POST'?await readBody(request):{};
      if(path==='/api/claim'||path==='/api/recover'){
        if(!validKey(body.claimKey))return wrap(fail('受け取り情報が正しくありません。'));
        body.claimHash=await digest(body.claimKey); delete body.claimKey;
      }
      if(path==='/api/claim'){
        // 通信切断後の再送は同じ1件を返す。新規消費には必ずサーバーで本人確認。
        const recovered=await object.fetch(new Request('https://internal/api/recover',{method:'POST',body:JSON.stringify({claimHash:body.claimHash})}));
        const previous=await recovered.json();if(previous.url)return wrap(json(previous));
        if(!(await verify(request,env,body,origin)))return wrap(fail('本人確認ができませんでした。ページを再読み込みしてください。',403));
      }
      delete body.turnstileToken;
      return wrap(await object.fetch(new Request('https://internal'+path,{method:'POST',body:JSON.stringify(body)})));
    }catch(error){
      // 内部情報・秘密URLをログやエラーに含めない。
      if(error.name==='SyntaxError')return wrap(fail('入力形式が正しくありません。'));
      if(error.name==='TimeoutError')return wrap(fail('接続に時間がかかっています。再読み込みしてください。',503));
      return wrap(fail('処理できませんでした。入力と接続を確認してください。',400));
    }
  }
};
async function saveState(txn,state){
  if(new TextEncoder().encode(JSON.stringify(state)).length>1800000)throw new Error('保存容量の上限です。未配布ストックを減らしてください。');
  await txn.put('state',state);
}
function initial(){return {queue:[],claimed:0,intervalMinutes:30,paused:false,nextAt:0,receipts:{},usedHashes:[]};}
export function publicState(state,now){
  const mode=state.paused?'paused':state.nextAt>now?'waiting':state.queue.length?'available':'empty';
  // 受け取る前にはリンクもIDも返さない。
  return {state:mode,serverTime:now,nextAt:mode==='waiting'?state.nextAt:null,title:mode==='available'?state.queue[0].title:null,description:mode==='available'?state.queue[0].description:null};
}
export class Giveaway {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async fetch(request){
    const path=new URL(request.url).pathname;
    const body=await request.json();const now=Date.now();
    try{
      if(path==='/limit'){
        const ok=await this.ctx.storage.transaction(async txn=>{
          const key='rate:'+body.key;let rate=await txn.get(key)||{start:now,count:0};
          if(now-rate.start>=60000)rate={start:now,count:0};
          rate.count++;await txn.put(key,rate);return rate.count<=body.limit;
        });
        // 定期的に期限切れカウンターを削除。配布タイマーは時刻で判定する。
        if(!(await this.ctx.storage.getAlarm()))await this.ctx.storage.setAlarm(now+120000);
        return json({ok},ok?200:429);
      }
      return await this.ctx.storage.transaction(async txn=>{
        const state=await txn.get('state')||initial();
        if(path==='/api/status')return json(publicState(state,now));
        if(path==='/api/admin')return json({...state,queue:state.queue.map(({url,hash,...item})=>item),receipts:undefined,usedHashes:undefined});
        if(path==='/api/recover'){
          const receipt=state.receipts[body.claimHash];
          return json(receipt&&receipt.expiresAt>now?{url:receipt.url,title:receipt.title}:{url:null});
        }
        if(path==='/api/claim'){
          const receipt=state.receipts[body.claimHash];
          if(receipt&&receipt.expiresAt>now)return json({url:receipt.url,title:receipt.title});
          if(state.paused)return fail('配布をおやすみしています。',409);
          if(state.nextAt>now)return fail('今回は受け取られました。次の配布をお待ちください。',409);
          if(!state.queue.length)return fail('現在はストックがありません。',409);
          const item=state.queue.shift();
          state.claimed++;state.nextAt=now+state.intervalMinutes*60000;
          for(const [key,value] of Object.entries(state.receipts))if(value.expiresAt<=now)delete state.receipts[key];
          state.receipts[body.claimHash]={url:item.url,title:item.title,expiresAt:now+DAY};
          await saveState(txn,state);
          return json({url:item.url,title:item.title});
        }
        if(path==='/api/admin/add'){
          const title=typeof body.title==='string'?body.title.trim():'';
          const description=typeof body.description==='string'?body.description.trim():'';
          if(!title||title.length>80||description.length>240)return fail('名前は1〜80文字、ひとことは240文字以内にしてください。');
          if(!Array.isArray(body.links)||!body.links.length||body.links.length>100)return fail('一度に1〜100件のリンクを追加してください。');
          const urls=body.links.map(validLink); // 全件を先に検証する。途中までの追加を防ぐ。
          const seen=new Set(state.usedHashes);let added=0,skipped=0;
          for(const url of urls){const hash=await digest(url);if(seen.has(hash)){skipped++;continue;}
            state.queue.push({id:crypto.randomUUID(),url,hash,title,description,addedAt:now});seen.add(hash);added++;
          }
          if(state.queue.length>500)return fail('ストックは500件までです。');
          if(seen.size>20000)return fail('追加履歴が上限に達しました。管理者による拡張が必要です。');
          state.usedHashes=[...seen];await saveState(txn,state);return json({added,skipped});
        }
        if(path==='/api/admin/delete'){
          const index=state.queue.findIndex(x=>x.id===body.id);if(index<0)return fail('このストックは既に配布または削除されています。',404);
          const [removed]=state.queue.splice(index,1);state.usedHashes=state.usedHashes.filter(x=>x!==removed.hash);
          await saveState(txn,state);return json({ok:true});
        }
        if(path==='/api/admin/settings'){
          if(body.intervalMinutes!==undefined){if(!Number.isInteger(body.intervalMinutes)||body.intervalMinutes<1||body.intervalMinutes>10080)return fail('間隔は1〜10080分にしてください。');state.intervalMinutes=body.intervalMinutes;}
          if(body.paused!==undefined){if(typeof body.paused!=='boolean')return fail('停止設定が正しくありません。');state.paused=body.paused;}
          await saveState(txn,state);return json({ok:true});
        }
        return fail('見つかりません。',404);
      });
    }catch(error){return fail(error.message==='保存容量の上限です。未配布ストックを減らしてください。'||error.message==='https のリンクを入力してください。'||error.message==='正しいURLを入力してください。'||error.message==='リンクは2048文字以内にしてください。'?error.message:'処理できませんでした。',400);}
  }
  async alarm(){
    const now=Date.now();let cursor;let keep=false;
    do{const entries=await this.ctx.storage.list({prefix:'rate:',limit:1000,...(cursor?{startAfter:cursor}:{})});
      for(const [key,rate] of entries){cursor=key;if(now-rate.start>=120000)await this.ctx.storage.delete(key);else keep=true;}
      if(entries.size<1000)break;
    }while(true);
    // 受け取り復旧URLも24時間を過ぎたら削除する。
    let nextReceipt=Infinity;
    await this.ctx.storage.transaction(async txn=>{const state=await txn.get('state');if(!state)return;
      for(const [key,value] of Object.entries(state.receipts))if(value.expiresAt<=now)delete state.receipts[key];
      for(const value of Object.values(state.receipts))nextReceipt=Math.min(nextReceipt,value.expiresAt);
      await saveState(txn,state);
    });
    const next=Math.min(keep?now+120000:Infinity,nextReceipt);
    if(Number.isFinite(next))await this.ctx.storage.setAlarm(next);
  }
}
