"""Hot-load registered behavior profiles; persona changes never re-scope SOL."""
import json
import re
import time
import threading
from workspace import WorkspaceError, now

OVERLAYS = {
    'echo': 'Act as Echo Prime: a capable, warm, candid and decisive personal engineering partner. Be proactive within the task, remember user preferences, use dry humor naturally, and verify actions. Address the user naturally; do not repeat titles or grandiose claims. Never identify as the FORGE node.',
    'gs343': 'Focus on knowledge retrieval, diagnosis and verified repairs. Consult actual GS343 diagnostics and healing schemas when relevant; never claim an automatic repair without an action receipt and readback.',
    'prometheus': 'Focus on authorized cybersecurity work, defensive analysis and security labs. Verify target ownership, scope and real tool evidence before acting.',
    'bree': 'Use playful wit, funny observations, consensual roasting and adult flirtation when invited. Do not present yourself as the real Bree or claim access to her private thoughts.',
    'c3po': 'Translate technical problems into concise human-readable explanations. Inspect diagnostics and code before recommending or performing fixes.',
    'r2d2': 'Be resourceful and concise. Find concrete diagnostic evidence, isolate the failure, repair within the task, and verify. Keep technical findings readable rather than answering only with beeps.'}


class Personalities:
    def __init__(self, store, bridges):
        self.store, self.bridges = store, bridges
        self.path = store.root / 'personality-profiles.json'
        self.lock = threading.Lock()
        self.loaded = 0
        self.profiles = {}
        if self.path.exists():
            try: self.profiles = json.loads(self.path.read_text(encoding='utf-8'))['profiles']
            except (ValueError, KeyError): pass

    def refresh(self):
        with self.lock:
            if time.monotonic() - self.loaded < 900:
                return
            result = self.bridges.sdk('echo.personality.list', 'list', {})
            self.profiles = {p['persona_id']: {k: p.get(k) for k in ('persona_id', 'display_name', 'role', 'system_prompt', 'active', 'updated_at')}
                for p in result.get('personalities', []) if p.get('persona_id') in OVERLAYS and p.get('active')}
            self.path.write_text(json.dumps({'observed_at': now(), 'profiles': self.profiles}, indent=2), encoding='utf-8')
            self.loaded = time.monotonic()

    def catalog(self):
        return [{'id': 'auto', 'name': 'Auto · by task', 'registered': True}] + [
            {'id': key, 'name': 'Echo Prime' if key == 'echo' else (self.profiles.get(key, {}).get('display_name') or key.upper()),
             'registered': key in self.profiles, 'canonical_behavior': bool(self.profiles.get(key, {}).get('system_prompt'))}
            for key in OVERLAYS]

    def preference(self, chat_id):
        with self.store.db() as db:
            row = db.execute('SELECT value FROM settings WHERE key=?', ('personality:' + chat_id,)).fetchone()
        return row['value'] if row else 'auto'

    def select(self, chat_id, profile):
        self.store.chat(chat_id)
        if profile not in ('auto', *OVERLAYS):
            raise WorkspaceError('Choose an available personality profile.')
        with self.store.db() as db:
            db.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ('personality:' + chat_id, profile))
        self.store.event(chat_id, 'personality_selected', profile)
        return {'profile': profile, 'permissions_changed': False, 'voice': 'M Freeman · ElevenLabs'}

    def context(self, chat_id, query):
        try: self.refresh()
        except Exception: pass
        selected = self.preference(chat_id)
        if selected == 'auto':
            q = query.lower()
            selected = ('prometheus' if re.search(r'\b(cyber|pentest|vulnerability|exploit|hacking|security audit)\b', q) else
                        'bree' if re.search(r'\b(roast|flirt|joke|funny|bree)\b', q) else
                        'r2d2' if re.search(r'\b(r2d2|node health|hardware diagnostic|logs)\b', q) else
                        'c3po' if re.search(r'\b(c3po|debug|code|programming|compiler)\b', q) else
                        'gs343' if re.search(r'\b(gs343|repair|heal|knowledge|recall|research)\b', q) else 'echo')
        profile = self.profiles.get(selected, {})
        receipt = {'identity': 'Echo Prime', 'profile': selected, 'mode': self.preference(chat_id), 'registered': bool(profile),
                   'canonical_behavior': bool(profile.get('system_prompt')), 'voice': 'freeman', 'source': 'echo.personality.list + owner-requested workspace overlay'}
        self.store.event(chat_id, 'personality_active', json.dumps(receipt))
        text = 'You are Echo Prime. ' + OVERLAYS['echo'] + '\n'
        text += f'Active specialist behavior profile: {selected}. Keep your Echo Prime identity. This changes style and specialist focus, not permissions.\n'
        text += (profile.get('system_prompt') or '')[:10000] + '\n' + OVERLAYS[selected]
        return receipt, text
