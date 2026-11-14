// This worker runs on the viewer's device, not on GitHub or an application server.
// No cache, IndexedDB, analytics or upload. Only declared MP4 header bytes change.
const sources = new Map();
const prefix = new URL('./_stream/',self.registration.scope).pathname;
function valid(entry) {
  try { const u=new URL(entry.href); return u.protocol==='https:' && !u.username && !u.password && /(^|\.)(yandex\.(ru|net|com|com\.tr|by|kz)|yandexcloud\.net)$/.test(u.hostname) && Number.isSafeInteger(entry.size) && entry.size>0 && entry.expires>Date.now() && Array.isArray(entry.patches) && entry.patches.length<=100 && entry.patches.every(p=>Number.isSafeInteger(p)&&p>=0&&p+4<=entry.size); } catch { return false; }
}
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{
  const {type,token,entry}=event.data||{};
  if(type==='disk-play-register') {
    for(const [key,value] of sources)if(value.expires<Date.now())sources.delete(key);
    if(typeof token==='string' && valid(entry)){sources.set(token,entry);event.ports[0]?.postMessage({ok:true});}else event.ports[0]?.postMessage({ok:false});
  } else if(type==='disk-play-release')sources.delete(token);
});
async function lookup(token,clientId) {
  if(valid(sources.get(token)))return sources.get(token);
  const clients=clientId?[await self.clients.get(clientId)]:await self.clients.matchAll({type:'window'});
  for(const client of clients.filter(Boolean)) {
    const value=await new Promise(resolve=>{const channel=new MessageChannel();const timer=setTimeout(()=>{channel.port1.close();resolve(null);},1500);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data);};client.postMessage({type:'disk-play-source',token},[channel.port2]);});
    if(valid(value)){sources.set(token,value);return value;}
  }
  return null;
}
function rangeOf(value,size) {
  if(!value)return {start:0,end:size-1,partial:false};
  const match=/^bytes=(\d*)-(\d*)$/.exec(value);if(!match||(!match[1]&&!match[2]))return null;
  const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  const end=match[1]&&match[2]?Math.min(size-1,Number(match[2])):size-1;
  return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<=end&&start<size?{start,end,partial:true}:null;
}
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||!url.pathname.startsWith(prefix))return;
  event.respondWith(stream(event,url.pathname.slice(prefix.length)));
});
async function stream(event,token) {
  if(!['GET','HEAD'].includes(event.request.method))return new Response(null,{status:405});
  const entry=await lookup(token,event.clientId);if(!entry)return new Response('Обновите ссылку в плеере.',{status:410});
  const range=rangeOf(event.request.headers.get('Range'),entry.size);
  if(!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${entry.size}`}});
  const {start,end,partial}=range;
  const headers={'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':String(end-start+1),'Cache-Control':'no-store'};
  if(partial)headers['Content-Range']=`bytes ${start}-${end}/${entry.size}`;
  if(event.request.method==='HEAD')return new Response(null,{status:partial?206:200,headers});
  try {
    const response=await fetch(entry.href,{headers:{Range:`bytes=${start}-${end}`},credentials:'omit',referrerPolicy:'no-referrer',signal:event.request.signal,cache:'no-store'});
    if(response.status!==206||!response.body){await response.body?.cancel();return new Response('Видео временно недоступно.',{status:502});}
    const remoteRange=response.headers.get('Content-Range');
    if(remoteRange&&remoteRange!==`bytes ${start}-${end}/${entry.size}`){await response.body.cancel();return new Response(null,{status:502});}
    let position=start;const replacement=[104,118,99,49];
    const output=response.body.pipeThrough(new TransformStream({transform(chunk,controller){
      if(position+chunk.length>end+1)throw new Error('Некорректный диапазон');
      let data=chunk;
      for(const patch of entry.patches)if(patch<position+chunk.length&&patch+4>position){if(data===chunk)data=chunk.slice();for(let i=0;i<4;i++){const index=patch+i-position;if(index>=0&&index<data.length)data[index]=replacement[i];}}
      position+=chunk.length;controller.enqueue(data);
    },flush(){if(position!==end+1)throw new Error('Поток прервался');}}));
    return new Response(output,{status:partial?206:200,headers});
  }catch{return new Response('Ошибка чтения видео.',{status:502});}
}
