import { config } from './config.js';
import { api } from './api.js';
const $ = id => document.getElementById(id);
$('bio').textContent = config.bio;
let state = null, busy = false, serverOffset = 0, verificationToken = '', widget, refreshTimer, rewardUrl = '';
let claimKey;
try { claimKey = sessionStorage.getItem('taka-claim-key'); } catch {}
function storeKey(key) {
  claimKey = key;
  try { if(key) sessionStorage.setItem('taka-claim-key',key); else sessionStorage.removeItem('taka-claim-key'); } catch {}
}
function render() {
  const available = !!rewardUrl || state?.state === 'available';
  $('claim').textContent = available ? '受け取る' : '補充中…';
  $('claim').disabled = busy || !available || (!rewardUrl && !!config.turnstileSiteKey && !verificationToken);
  $('claim').setAttribute('aria-busy',String(busy));
}
function validateReward(data) {
  const url = new URL(data.url);
  if(url.protocol !== 'https:' || url.username || url.password) throw new Error('リンクを確認できませんでした。');
  rewardUrl = url.href;
}
function openReward() {
  storeKey(null);
  window.location.assign(rewardUrl);
}
async function refresh() {
  if(!config.apiBase) { render(); return; }
  try {
    state = await api('/api/status');
    serverOffset = state.serverTime - Date.now();
    $('status-message').textContent = '';
  } catch {
    state = null;
    $('status-message').textContent = '配布状況を確認できませんでした。自動で再確認します。';
  }
  render();
}
async function recover() {
  if(!claimKey || !config.apiBase) return;
  const data = await api('/api/recover',{method:'POST',body:{claimKey}});
  if(data.url) validateReward(data); else storeKey(null);
  render();
}
$('claim').addEventListener('click',async()=>{
  if(busy) return;
  busy = true; render();
  try {
    if(!rewardUrl) await recover();
    if(rewardUrl) { openReward(); return; }
    storeKey(crypto.randomUUID());
    const data = await api('/api/claim',{method:'POST',body:{claimKey,turnstileToken:verificationToken}});
    validateReward(data);
    openReward();
  } catch(error) {
    await refresh();
    const message = error.name === 'TimeoutError' ? '通信が途切れました。再読み込みすると受け取り結果を確認できます。' : error.message;
    $('status-message').textContent = message;
    window.alert(message);
  } finally {
    busy = false; verificationToken = '';
    if(widget !== undefined) window.turnstile?.reset(widget);
    render();
  }
});
if(config.turnstileSiteKey && config.apiBase) {
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.onload = ()=>{ widget = window.turnstile.render('#verification',{
    sitekey:config.turnstileSiteKey,action:'claim',theme:'light',size:'flexible',appearance:'interaction-only',
    callback:token=>{verificationToken=token;render();},
    'expired-callback':()=>{verificationToken='';render();},
    'error-callback':()=>{verificationToken='';render();$('status-message').textContent='本人確認に失敗しました。再読み込みしてください。';},
  }); };
  script.onerror = ()=>{ $('status-message').textContent='本人確認を読み込めませんでした。再読み込みしてください。'; };
  document.head.append(script);
}
await refresh();
try { await recover(); } catch { $('status-message').textContent = '前回の受け取り確認に失敗しました。再読み込みしてください。'; }
setInterval(()=>{if(!document.hidden&&!busy) refresh();},15000);
setInterval(()=>{
  if(state?.state==='waiting' && state.nextAt<=Date.now()+serverOffset && !refreshTimer && !busy) {
    refreshTimer=setTimeout(async()=>{await refresh();refreshTimer=undefined;},1000);
  }
},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!busy) refresh();});

$('admin-open').addEventListener('click',async()=>{
  try { const {openAdmin}=await import('./admin.js');openAdmin(); }
  catch { window.alert('管理画面を開けませんでした。再読み込みしてください。'); }
});
