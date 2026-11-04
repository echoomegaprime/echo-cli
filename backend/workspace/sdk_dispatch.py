"""Use the installed broker with its inherited token; never issue or refresh scope."""
import argparse
import json
import os
import re
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--capability', required=True)
    parser.add_argument('--command', required=True)
    parser.add_argument('--options-file', choices=['-'], required=True)
    args = parser.parse_args()
    if not os.environ.get('SOL_BROKER_TOKEN') or not os.environ.get('SOL_STATE_DB'):
        print(json.dumps({'error': 'No SOL mission scope'}), file=sys.stderr)
        return 2
    sys.path.insert(0, args.runtime)
    from sol_cli import main as governed_main
    try:
        return governed_main(['--state', os.environ['SOL_STATE_DB'], 'sdk', 'invoke',
                              args.capability, args.command, '--options-file', '-'])
    except Exception as exc:
        text = str(exc).lower()
        # Return only machine error codes / HTTP status, never a raw response body.
        code = re.search(r'"error"\s*:\s*"([a-z][a-z0-9_]{1,80})"', text)
        http = re.search(r'sdk http (\d{3})', text)
        category = ('Outside current role scope' if 'scope' in text else
                    'Scoped token expired or revoked' if 'token' in text else
                    ('SDK HTTP ' + http.group(1) + ': ' + (code.group(1) if code else 'provider_error')) if http else
                    'Scoped SDK operation failed; consult the mission audit')
        print(json.dumps({'error': category}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
