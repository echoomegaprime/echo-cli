"""Durable document outbox with exact Knowledge Forge readback."""
import hashlib
import json
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from workspace import redact, now
from audit import record


class Knowledge:
    def __init__(self, store, bridges):
        self.store, self.bridges = store, bridges
        self.path = store.root / 'knowledge.sqlite3'
        self.lock, self.stop = threading.Lock(), threading.Event()
        with self.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT,body TEXT,source TEXT,sha256 TEXT,chat_id TEXT,state TEXT,attempts INTEGER DEFAULT 0,next_attempt REAL DEFAULT 0,error TEXT DEFAULT '',updated TEXT)")

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def enqueue(self, title, body, source_path, chat_id=None):
        source_path = str(source_path)
        if re.search(r'(?i)(?:^|[/\\])(?:\.env(?:\..*)?|id_rsa|id_ed25519|master_vault\.db|credentials\.json|sol-mission\.json)$', source_path) or re.search(r'-----BEGIN .*PRIVATE KEY-----', body):
            return {'queued': False, 'reason': 'Credential material is excluded'}
        body = redact(body)
        ids = []
        total = max(1, (len(body) + 49999) // 50000)
        for n in range(total):
            part = body[n*50000:(n+1)*50000]
            source_hash = hashlib.sha256(part.encode()).hexdigest()
            text = f'Source: {source_path}\nPart: {n+1}/{total}\nSource-part-SHA256: {source_hash}\n\n{part}\nEND ECHO DOCUMENT'
            digest = hashlib.sha256(text.encode()).hexdigest()
            identifier = 'qwen-doc-' + hashlib.sha256((source_path + '\n' + str(n) + '\n' + digest).encode()).hexdigest()[:40]
            with self.db() as db:
                db.execute('INSERT OR IGNORE INTO documents(id,title,body,source,sha256,chat_id,state,updated) VALUES(?,?,?,?,?,?,?,?)',
                    (identifier, str(title)[:180], text, source_path, digest, chat_id, 'pending', now()))
            ids.append(identifier)
        return {'queued': True, 'ids': ids, 'parts': total}

    def scan(self):
        for entry in self.store.library():
            item = self.store.library_get(entry['id'])
            self.enqueue(item['name'], item['content'], item['path'], item.get('chat_id'))
        for chat in self.store.chats():
            path = self.store.root / 'journals' / (chat['id'] + '.md')
            if path.is_file():
                self.enqueue(chat['title'], path.read_text(encoding='utf-8'), str(path), chat['id'])

    def _matches(self, job):
        result = self.bridges.sdk('echo.knowledge.get', 'get', {'doc_id': job['id'], 'include_body': True})
        doc = result.get('data', result.get('doc', {}))
        return doc.get('doc_id') == job['id'] and doc.get('body_sha256') == job['sha256'] and doc.get('body_md') == job['body']

    def once(self):
        if not self.lock.acquire(blocking=False):
            return self.status()
        try:
            with self.db() as db:
                jobs = [dict(r) for r in db.execute("SELECT * FROM documents WHERE state!='verified' AND next_attempt<=? ORDER BY rowid LIMIT 8", (time.time(),))]
            for job in jobs:
                if self.stop.is_set(): break
                try:
                    verified = False
                    if job['attempts']:
                        try: verified = self._matches(job)
                        except Exception: pass
                    if not verified:
                        if job['state'] != 'written':
                            # An immutable ID + body makes the provider upsert idempotent.
                            with self.db() as db:
                                db.execute('UPDATE documents SET attempts=attempts+1,updated=? WHERE id=?', (now(), job['id']))
                            self.bridges.sdk('echo.knowledge.ingest', 'ingest', {'doc_id': job['id'], 'title': job['title'],
                                'body_md': job['body'], 'source_path': job['source'], 'category': 'qwen-workspace', 'tags': ['qwen-workspace', 'autonomous-ingestion']})
                            with self.db() as db:
                                db.execute("UPDATE documents SET state='written' WHERE id=?", (job['id'],))
                        verified = self._matches(job)
                    if not verified:
                        raise ValueError('Knowledge Forge exact body/hash readback differs')
                    with self.db() as db:
                        db.execute("UPDATE documents SET state='verified',error='',updated=? WHERE id=?", (now(), job['id']))
                    record(self.store.root / 'operations.jsonl', operation='knowledge_ingest', job_id=job['id'], status='verified', verification='exact_body_and_sha256')
                except Exception as exc:
                    with self.db() as db:
                        db.execute('UPDATE documents SET error=?,next_attempt=?,updated=? WHERE id=?',
                            (redact(str(exc))[:400], time.time() + min(300, 20 * (job['attempts'] + 1)), now(), job['id']))
                    record(self.store.root / 'operations.jsonl', operation='knowledge_ingest', job_id=job['id'], status='retry', error_category=type(exc).__name__)
            return self.status()
        finally:
            self.lock.release()

    def status(self):
        with self.db() as db:
            counts = {r['state']: r['n'] for r in db.execute('SELECT state,count(*) n FROM documents GROUP BY state')}
            error = db.execute("SELECT error FROM documents WHERE error!='' ORDER BY updated DESC LIMIT 1").fetchone()
        return {**counts, 'remaining': sum(v for k, v in counts.items() if k != 'verified'), 'last_issue': error['error'] if error else '', 'embedding': 'Queued by Forge; embedding completion is separate'}

    def start(self):
        def loop():
            while not self.stop.is_set():
                try:
                    self.scan()
                    self.once()
                except Exception as exc:
                    record(self.store.root / 'operations.jsonl', operation='knowledge_scan', status='error', error_category=type(exc).__name__)
                self.stop.wait(15)
        threading.Thread(target=loop, daemon=True).start()
