"""Copy a Workspace data root for a SEPARATE test backend. Source is opened read-only.

Usage: copy-workspace-data.py <source-data-root> <dest-data-root>
SQLite files go through the online backup API (consistent snapshot, source never written).
Identity/session stores, connection credentials, voice artifacts and operation logs are not copied.
Configure reviewed connector references separately. No source data is modified or deleted.
"""
import shutil, sqlite3, sys
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
if not src.is_dir():
    sys.exit(f"source missing: {src}")
if dst.exists() and any(dst.iterdir()):
    sys.exit(f"refusing non-empty destination: {dst}")
dst.mkdir(parents=True, exist_ok=True)
for db in ("workspace.sqlite3", "knowledge.sqlite3"):
    s = src / db
    if s.exists():
        a = sqlite3.connect(f"file:{s.as_posix()}?mode=ro", uri=True)
        b = sqlite3.connect(dst / db)
        with b:
            a.backup(b)
        a.close(); b.close()
        print("backed up", db)
for d in ("library", "journals"):
    if (src / d).is_dir():
        shutil.copytree(src / d, dst / d)
        print("copied", d)
for f in ("personality-profiles.json",):
    if (src / f).is_file():
        shutil.copy2(src / f, dst / f)
        print("copied", f)
