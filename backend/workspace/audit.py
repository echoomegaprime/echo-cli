"""Bounded metadata-only diagnostics; never record request/response bodies."""
import json
import threading
from pathlib import Path
from workspace import now

_lock = threading.Lock()
_fields = {'operation', 'status', 'duration_ms', 'capability', 'command', 'run_id',
           'tenant', 'actor', 'admission', 'http_status', 'error_category', 'count', 'job_id', 'chat_id', 'bytes', 'source', 'verification'}


def record(path, **fields):
    if not path:
        return
    row = {'observed_at_utc': now(), **{k: v for k, v in fields.items() if k in _fields}}
    target = Path(path)
    with _lock:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.stat().st_size > 5_000_000:
            target.replace(target.with_suffix('.previous.jsonl'))
        with target.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(row, ensure_ascii=True) + '\n')


def recent(path, limit=100):
    from collections import deque
    target = Path(path)
    if not target.exists():
        return []
    with target.open(encoding='utf-8') as stream:
        lines = deque(stream, maxlen=min(limit, 200))
    result = []
    for line in lines:
        try:
            result.append(json.loads(line))
        except ValueError:
            continue
    return result
