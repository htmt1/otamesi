import { api } from './api.js';
const $ = id => document.getElementById(id);
let token='', current, generation=0;
function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'';}
async function call(path,body,method='POST'){const version=generation;const data=await api(path,{token,body,method});if(version!==generation){const error=new Error('管理画面を閉じたため中止しました。');error.name='AbortError';throw error;}return data;}
async function load(){
  current=await call('/api/admin',undefined,'GET');
  $('queued').textContent=current.queue.length; $('claimed').textContent=current.claimed;
  $('mode').textContent=current.paused?'停止中':'配布中'; $('pause').textContent=current.paused?'配布を再開':'配布を一時停止';
  $('interval').value=current.intervalMinutes;
  $('next-time').textContent=current.nextAt>Date.now()?`次の配布：${new Date(current.nextAt).toLocaleString('ja-JP')}`:'待ち時間なし';
  $('queue').replaceChildren();
  for(const item of current.queue){
    const row=document.createElement('li'),label=document.createElement('div'),small=document.createElement('small'),remove=document.createElement('button');
    label.textContent=item.title;small.textContent=`追加 ${new Date(item.addedAt).toLocaleString('ja-JP')}`; label.append(small);
    remove.textContent='削除';remove.className='secondary';remove.type='button';
    remove.onclick=async()=>{if(!confirm(`「${item.title}」をストックから削除しますか？`))return;remove.disabled=true;try{await call('/api/admin/delete',{id:item.id});await load();message('削除しました。');}catch(e){if(e.name!=='AbortError')message(e.message,true);remove.disabled=false;}};
    row.append(label,remove);$('queue').append(row);
  }
  if(!current.queue.length){const row=document.createElement('li');row.textContent='まだストックがありません。';$('queue').append(row);}
}
function onForm(id,handler){$(id).addEventListener('submit',async event=>{event.preventDefault();const button=$(id).querySelector('button');button.disabled=true;try{await handler();}catch(e){if(e.name!=='AbortError')message(e.message,true);}finally{button.disabled=false;}});}
onForm('login',async()=>{token=$('admin-token').value;try{await load();}catch(e){token='';throw e;}$('admin-token').value='';$('login-section').hidden=true;$('dashboard').hidden=false;message('管理画面を開きました。');});
onForm('add',async()=>{const result=await call('/api/admin/add',{title:$('title').value,description:$('description').value,links:$('links').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)});$('links').value='';await load();message(`${result.added}件追加しました。重複 ${result.skipped}件。`);});
onForm('settings',async()=>{await call('/api/admin/settings',{intervalMinutes:Number($('interval').value)});await load();message('設定を保存しました。');});
$('pause').onclick=async()=>{ $('pause').disabled=true;try{await call('/api/admin/settings',{paused:!current.paused});await load();message(current.paused?'配布を停止しました。':'配布を再開しました。');}catch(e){if(e.name!=='AbortError')message(e.message,true);}finally{$('pause').disabled=false;} };
function reset(){generation++;token='';current=null;$('queue').replaceChildren();$('login').reset();$('add').reset();$('dashboard').hidden=true;$('login-section').hidden=false;message('');}
$('logout').onclick=()=>{reset();message('ログアウトしました。');};
$('admin-close').onclick=()=>$('admin-dialog').close();
$('admin-dialog').addEventListener('close',reset);
$('admin-dialog').addEventListener('click',event=>{if(event.target===$('admin-dialog')){const rect=$('admin-dialog').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$('admin-dialog').close();}});

export function openAdmin(){ $('admin-dialog').showModal(); $('admin-token').focus(); }
