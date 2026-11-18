"""Local, cancellable yt-dlp imports. No shell, cookies or user config loading."""
import os
import signal
import json
import secrets
import shutil
import subprocess
import threading
from pathlib import Path
from urllib.parse import urlsplit

VIDEO_EXTENSIONS={'.mp4','.mkv','.webm','.mov','.avi','.m4v','.ts','.mts','.m2ts','.mpeg','.mpg','.wmv','.flv','.ogv','.3gp','.vob','.mxf','.asf','.m2v','.mpe','.f4v','.3g2'}

class WebImports:
    def __init__(self, root, busy=lambda: False):
        self.root=Path(root).resolve(); self.busy=busy
        self.lock=threading.RLock(); self.jobs={}; self.process=None; self.cancelled=set()
    def snapshot(self, ident):
        with self.lock:
            if ident not in self.jobs: raise ValueError('Загрузка не найдена.')
            return dict(self.jobs[ident])
    def start(self, url):
        url=str(url or '').strip(); parsed=urlsplit(url)
        if parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('Укажите HTTP(S)-ссылку на видео или плейлист.')
        if not shutil.which('yt-dlp'):
            raise ValueError('Нужен локальный yt-dlp: python3 -m pip install -U "yt-dlp[default]". Также установите FFmpeg и JavaScript runtime для YouTube.')
        with self.lock:
            if self.busy(): raise ValueError('Приоритет у поиска людей. Дождитесь завершения анализа.')
            if any(j['status'] in {'running','cancelling'} for j in self.jobs.values()): raise ValueError('Уже идёт загрузка. Дождитесь завершения или отмените её.')
            ident=secrets.token_hex(12)
            self.jobs[ident]={'id':ident,'status':'running','message':'Получаем видео с сайта…','count':0}
            threading.Thread(target=self.run,args=(ident,url),daemon=True).start()
            return dict(self.jobs[ident])
    def terminate(self, process):
        if process.poll() is not None:return
        try:
            if os.name == "posix":os.killpg(process.pid,signal.SIGTERM)
            else:process.terminate()
        except ProcessLookupError:pass
    def cancel(self, ident):
        with self.lock:
            job=self.snapshot(ident)
            if job['status']!='running':return job
            self.cancelled.add(ident); self.jobs[ident].update(status='cancelling',message='Отменяем загрузку…')
            if self.process and self.process.poll() is None:self.terminate(self.process)
            return dict(self.jobs[ident])
    def run(self, ident, url):
        folder=self.root/ident; folder.mkdir(parents=True,exist_ok=True)
        try:
            # Paths controlled by yt-dlp's sanitized placeholders, never by shell.
            args=[shutil.which('yt-dlp'),'--ignore-config','--no-color','--newline','--yes-playlist','--continue','--no-overwrites','--windows-filenames','--socket-timeout','20','--retries','3','--no-write-info-json','--no-write-thumbnail','--merge-output-format','mp4/mkv','--paths',str(folder),'-o','%(playlist_title|Видео)s/%(playlist_index|0)05d - %(title).160B [%(id)s].%(ext)s','--progress-template','download:Загрузка: %(progress._percent_str)s · %(progress._speed_str)s · осталось %(progress._eta_str)s','--',url]
            if shutil.which('node'):args[1:1]=['--js-runtimes','node']
            with self.lock:
                if ident in self.cancelled:raise InterruptedError()
                process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',start_new_session=(os.name=="posix"));self.process=process
            def read_progress():
                for line in process.stdout:
                    with self.lock:
                        if line.startswith('Загрузка:'):self.jobs[ident]['message']=line.strip()[:240]
            reader=threading.Thread(target=read_progress,daemon=True);reader.start()
            while process.poll() is None:
                with self.lock:
                    if self.busy() or ident in self.cancelled:
                        self.cancelled.add(ident)
                        self.terminate(process)
                try:process.wait(timeout=.3)
                except subprocess.TimeoutExpired:pass
            reader.join(timeout=2)
            process.stdout.close()
            code=process.wait()
            files=[p for p in folder.rglob('*') if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS]
            with self.lock:
                if ident in self.cancelled:raise InterruptedError()
                if not files:raise ValueError('Сайт не отдал видео. Проверьте доступность ссылки; может требоваться вход или обновление yt-dlp. Защищённые видео не поддерживаются.')
                self.jobs[ident].update(status='done',path=str(folder),count=len(files),message=f'Скачано видео: {len(files)}.'+(' Часть элементов недоступна.' if code else ''))
        except InterruptedError:
            with self.lock:self.jobs[ident].update(status='cancelled',message='Загрузка отменена. Уже скачанные файлы сохранены.',path=str(folder))
        except Exception as error:
            with self.lock:self.jobs[ident].update(status='error',message=str(error) if isinstance(error,ValueError) else 'Ошибка локального загрузчика.')
        finally:
            with self.lock:self.process=None
            for p in folder.rglob('*.part'):
                p.unlink(missing_ok=True)
    def files(self, ident):
        job=self.snapshot(ident)
        if job['status']!='done':raise ValueError('Дождитесь завершения загрузки.')
        folder=self.root/ident
        return [{'name':p.name,'path':p.relative_to(folder).as_posix(),'size':p.stat().st_size} for p in sorted(folder.rglob('*')) if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS]
