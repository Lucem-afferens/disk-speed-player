#!/usr/bin/env python3
"""Disk Play local edition with optional yt-dlp imports; bind loopback only."""
import json
import mimetypes
import re
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote
from web_import import WebImports
ROOT=Path(__file__).resolve().parent
IMPORTS=WebImports(ROOT/'imports')
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self,*args):pass
    def valid(self):return self.headers.get('Host') in {'localhost:8787','127.0.0.1:8787'}
    def json(self,value,status=200):
        body=json.dumps(value,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
    def do_POST(self):
        if not self.valid() or self.headers.get('Origin','') not in {'','http://localhost:8787','http://127.0.0.1:8787'}:return self.json({'error':'Недопустимый источник'},403)
        try:
            length=int(self.headers.get('Content-Length',0))
            if self.headers.get('Content-Type','').split(';')[0]!='application/json' or not 0<length<16384:raise ValueError('Некорректный запрос')
            data=json.loads(self.rfile.read(length));route=urlsplit(self.path).path
            if route=='/api/import/start':return self.json(IMPORTS.start(data.get('url')))
            if route=='/api/import/cancel':return self.json(IMPORTS.cancel(data.get('id')))
            if route=='/api/import/status':
                result=IMPORTS.snapshot(data.get('id'))
                if result['status']=='done':result['items']=IMPORTS.files(result['id'])
                return self.json(result)
            return self.json({'error':'Не найдено'},404)
        except (ValueError,TypeError,KeyError) as e:return self.json({'error':str(e)},400)
    def do_GET(self):
        if not self.valid():return self.json({'error':'Недопустимый Host'},403)
        route=unquote(urlsplit(self.path).path)
        if route=='/api/import/capability':return self.json({'available':True})
        if route.startswith('/imports/'):
            file=(ROOT/route.lstrip('/')).resolve();root=(ROOT/'imports').resolve()
            if not file.is_relative_to(root) or not file.is_file() or file.suffix.lower() not in {'.mp4','.mkv','.webm','.mov','.ts','.avi','.m4v','.mts','.m2ts','.mpeg','.mpg','.wmv','.flv','.ogv','.3gp','.vob','.mxf','.asf','.m2v','.mpe','.f4v','.3g2'}:return self.json({'error':'Не найдено'},404)
            size=file.stat().st_size;start,end=0,size-1;r=self.headers.get('Range')
            if r:
                match=re.fullmatch(r'bytes=(\d+)-(\d*)',r)
                if not match:return self.json({'error':'Некорректный диапазон'},416)
                start=int(match[1]);end=min(int(match[2]) if match[2] else end,end)
                if start>end:return self.json({'error':'Некорректный диапазон'},416)
            self.send_response(206 if r else 200);self.send_header('Content-Type',mimetypes.guess_type(file.name)[0] or 'application/octet-stream');self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(end-start+1))
            if r:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
            self.end_headers()
            try:
                with file.open('rb') as f:
                    f.seek(start);left=end-start+1
                    while left:
                        chunk=f.read(min(left,256*1024))
                        if not chunk:break
                        self.wfile.write(chunk);left-=len(chunk)
            except (BrokenPipeError,ConnectionResetError):pass
            return
        # Never expose Python sources, dotfiles, repository metadata or directory listings.
        name=route.lstrip('/') or 'index.html'
        if '/' in name or name.startswith('.') or Path(name).suffix not in {'.html','.js','.css','.svg','.png','.webmanifest'}:return self.json({'error':'Не найдено'},404)
        return super().do_GET()
    def list_directory(self,path):return self.json({'error':'Не найдено'},404)
if __name__=='__main__':
    print('Disk Play: http://127.0.0.1:8787 — Ctrl+C для остановки')
    try:ThreadingHTTPServer(('127.0.0.1',8787),Handler).serve_forever()
    except KeyboardInterrupt:pass
