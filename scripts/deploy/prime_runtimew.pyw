"""Windowless Task Scheduler entry point; never invokes a console or copies a login."""
import sys
from pathlib import Path

from prime_runtime import absolute, main


def launch():
    if len(sys.argv) < 4 or sys.argv[1:3] != ['run', '--stage']:
        return 2
    stage = absolute(sys.argv[3]).resolve(strict=True)
    # The stage ACL is established before its configuration is written. Native
    # children have separate logs; none of the argv/configuration is echoed.
    with (stage / 'supervisor.stdout.log').open('a', encoding='utf-8', buffering=1) as stdout, \
            (stage / 'supervisor.stderr.log').open('a', encoding='utf-8', buffering=1) as stderr:
        sys.stdout, sys.stderr = stdout, stderr
        return main()


if __name__ == '__main__':
    raise SystemExit(launch())
