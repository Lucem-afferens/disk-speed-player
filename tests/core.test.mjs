import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLink, mediaKey, isVideo, safeMediaURL, nativeRate, overviewTarget, timeLabel} from '../core.js';
test('public links preserve nested unicode paths and discard tracking parameters', () => {
  const value = parseLink('https://disk.360.yandex.ru/d/example/%D0%9A%D0%B0%D0%BC%D0%B5%D1%80%D0%B0/video.mp4?utm_source=share');
  assert.deepEqual(value, {key:'https://disk.360.yandex.ru/d/example',identity:'example',path:'/Камера/video.mp4'});
  assert.equal(parseLink('https://yadi.sk/i/example').path, '');
});
test('rejects misleading hosts, credentials, protocols and malformed paths', () => {
  for (const value of ['javascript:alert(1)','http://disk.yandex.ru/d/x','https://disk.yandex.ru.evil.test/d/x','https://u:p@disk.yandex.ru/d/x','https://disk.yandex.ru:8443/d/x','https://disk.yandex.ru/client/disk','https://disk.yandex.ru/d/x/%ZZ']) assert.throws(() => parseLink(value));
});
test('watch state is isolated by source, path and replacement file size', () => {
  const a={identity:'a'},b={identity:'b'};
  assert.notEqual(mediaKey(a,{path:'/same.mp4',size:10}),mediaKey(b,{path:'/same.mp4',size:10}));
  assert.notEqual(mediaKey(a,{path:'/same.mp4',size:10}),mediaKey(a,{path:'/same.mp4',size:20}));
});
test('only video files enter playlist', () => {
  assert.equal(isVideo({type:'file',name:'camera.MP4'}),true);
  assert.equal(isVideo({type:'file',mime_type:'video/quicktime'}),true);
  assert.equal(isVideo({type:'dir',name:'camera.mp4'}),false);
  assert.equal(isVideo({type:'file',name:'invoice.pdf'}),false);
});
test('media URLs must belong to HTTPS Yandex storage', () => {
  assert.equal(safeMediaURL('https://mds.storage.yandex.net/get-disk/a?b=c'),'https://mds.storage.yandex.net/get-disk/a?b=c');
  for(const url of ['http://downloader.disk.yandex.ru/a','https://evil.yandex.net.evil.test/a','javascript:alert(1)','https://evil.test/a']) assert.throws(() => safeMediaURL(url));
});
test('native speed fallback handles both exceptions and silent clamping', () => {
  let actual=1;
  const throws={set playbackRate(v){if(v>16)throw new Error();actual=v;},get playbackRate(){return actual;}};
  assert.equal(nativeRate(throws,32),16);
  const clamps={set playbackRate(v){actual=Math.min(4,v);},get playbackRate(){return actual;}};
  assert.equal(nativeRate(clamps,32),4);
});
test('32× overview skips only buffered data and never catches up after a stall', () => {
  const params={position:10,elapsed:.25,requested:32,actual:16,bufferEnd:20,duration:100};
  assert.equal(overviewTarget(params),14);
  assert.equal(overviewTarget({...params,bufferEnd:12}),null);
  assert.equal(overviewTarget({...params,elapsed:3}),null);
  assert.equal(overviewTarget({...params,actual:32}),null);
});
test('time formatting supports long videos and unknown duration', () => {
  assert.equal(timeLabel(3661),'1:01:01');assert.equal(timeLabel(62.9),'1:02');assert.equal(timeLabel(NaN),'—');
});
