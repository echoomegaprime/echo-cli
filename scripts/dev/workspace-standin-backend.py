"""Authenticated canonical Workspace backend with a STAND-IN issuer and model, for Prime development.

Runs the real canonical Workspace HTTP/auth/store code (echo_qwen_chat at the reviewed SHA) on a
separate loopback port against a COPY of the data root. Nothing here is a real identity provider
or the FORGE model: the issuer accepts one development password taken from the environment and the
model returns a fixed, clearly labelled reply. Sign-in at the real issuer (auth.echo-op.com) and the
FORGE model remain separate acceptance steps.

Usage:
  ECHO_STANDIN_PASSWORD=... python workspace-standin-backend.py \
      --source <dir containing app.py> --data <copied data root> --port 8771 --owner-uid <verified uid>

Sign in with the owner UID as the identifier and the environment password. The password is never
logged, written or committed.
"""
import argparse, json, os, sys, threading
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--source", required=True)
ap.add_argument("--data", required=True)
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--owner-uid", required=True)
ap.add_argument("--model-name", default="stand-in-model (no FORGE)")
ap.add_argument("--google-client-id", default=None, help="use the REAL canonical identity service (auth.echo-op.com) with this registered public Google client ID instead of the stand-in issuer")
ap.add_argument("--model-url", default=None, help="loopback Ollama endpoint; when set the real Workspace Model is used instead of the stand-in")
args = ap.parse_args()
password = os.environ.get("ECHO_STANDIN_PASSWORD", "")
if args.google_client_id is None and len(password) < 12:
    sys.exit("ECHO_STANDIN_PASSWORD (>= 12 chars) is required")
if args.port in (8768, 18767):
    sys.exit("refusing protected port")
sys.path.insert(0, args.source)
import app  # noqa: E402
from accounts import AuthError  # noqa: E402


class StandInIssuer:
    def login(self, body, client_ip=None):
        if body.get("password") != password:
            raise AuthError("Sign-in failed", 401)
        ident = str(body.get("email", "")).split("@")[0]
        return {"access_token": "standin-" + ident}

    def verify(self, token):
        uid = token.removeprefix("standin-")
        return {"uid": uid, "email": uid + "@standin.invalid", "email_verified": True}

    def logout(self, session):
        pass

    def client_config(self):
        return {"google_login_enabled": False}


class StandInModel:
    def __init__(self, *a, **k):
        pass

    def status(self):
        return {"ok": True, "model": args.model_name, "loaded": True}

    def generate(self, messages, on_token=None, max_tokens=2048, tools=None):
        text = f"[{args.model_name}] stand-in reply; the FORGE model is not connected."
        if on_token:
            on_token(text)
        return text


if args.model_url is None:
    app.Model = StandInModel
cfg = {
    "auth": {"enabled": True, "owner_uids": [args.owner_uid], "legacy_data_owner_uid": args.owner_uid,
             **({"google_client_id": args.google_client_id} if args.google_client_id else {})},
    "model_url": args.model_url or "http://127.0.0.1:1",
    "model": args.model_name,
    "context_length": 262144,
}
application = app.Application(Path(args.data), cfg)
server = app.make_server(application, args.port)
if args.google_client_id is None:
    server.accounts.accounts.provider = StandInIssuer()
print(json.dumps({"ready": True, "port": server.server_port, "standin": True}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
