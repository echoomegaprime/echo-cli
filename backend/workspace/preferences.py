"""Explicit user preferences, persisted locally and journaled for Fabric sync."""
import hashlib
import json
import re
from workspace import clean, now


class Preferences:
    def __init__(self, store):
        self.store = store
        with store.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS preferences(id TEXT PRIMARY KEY,content TEXT,chat_id TEXT,created TEXT,active INTEGER DEFAULT 1)')

    def list(self):
        with self.store.db() as db:
            return [dict(r) for r in db.execute('SELECT * FROM preferences WHERE active=1 ORDER BY created DESC LIMIT 100')]

    def save(self, content, chat_id):
        content = clean(content, 4000)
        self.store.chat(chat_id)
        identifier = hashlib.sha256(content.casefold().strip().encode()).hexdigest()[:32]
        with self.store.db() as db:
            existing = db.execute('SELECT id FROM preferences WHERE id=? AND active=1', (identifier,)).fetchone()
            db.execute('INSERT INTO preferences(id,content,chat_id,created,active) VALUES(?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET active=1',
                       (identifier, content, chat_id, now()))
        if not existing:
            self.store.event(chat_id, 'preference_saved', json.dumps({'id': identifier, 'content': content,
                'source': 'explicit_user_instruction', 'persistence': 'local_verified; ECF outbox pending readback'}))
        return {'saved': True, 'id': identifier, 'content': content, 'local_verified': True, 'ecf': 'automatic_outbox', 'replayed': bool(existing)}

    def capture(self, query, chat_id):
        # Only explicit forward-looking preferences. A recall question is not a new instruction.
        explicit = re.search(r"(?i)^(?:please\s+)?(?:remember\s*(?::|that\b|to\b)|from now on\b|(?:make|save|store)\s+(?:this\s+as\s+)?(?:a\s+)?memory\b)", query.strip())
        correction = re.search(r"(?i)\b(?:don['’]?t|do not|never|stop)\s+(?:say|read|speak|call|address|use)\b", query)
        if (explicit or correction) and len(query) <= 4000:
            return self.save(query, chat_id)
        return None

    def context(self):
        return '\n'.join(f'- {r["content"]}' for r in reversed(self.list()))[-16000:]

    def forget(self, identifier, chat_id):
        with self.store.db() as db:
            db.execute('UPDATE preferences SET active=0 WHERE id=?', (identifier,))
        self.store.event(chat_id, 'preference_disabled', json.dumps({'id': identifier, 'history_retained': True}))
        return {'disabled': True, 'id': identifier}
