"""End-to-end checks for Echo Prime on FORGE (run on FORGE as forge). Read-mostly; creates one throwaway bot and one
agent run on the free local lane, then deletes the bot. Prints one PASS/FAIL line per check and a JSON summary."""
import json, re, subprocess, sys, time, urllib.error, urllib.request

RESULTS = []
def check(name, fn):
    t = time.time()
    try:
        detail = fn()
        RESULTS.append({"check": name, "ok": True, "detail": detail, "s": round(time.time() - t, 1)})
        print(f"PASS {name}: {detail}")
    except Exception as exc:  # noqa: BLE001
        RESULTS.append({"check": name, "ok": False, "detail": str(exc)[:300], "s": round(time.time() - t, 1)})
        print(f"FAIL {name}: {str(exc)[:300]}")

def http(url, method="GET", body=None, headers=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"} if body is not None else {}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(); return r.status, dict(r.headers), raw
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()

PRIME = "http://127.0.0.1:8776"; HOST = {"Host": "echoomegaprime.com"}
ADK = "http://127.0.0.1:8378"

def prime_assets():
    s, h, raw = http(PRIME + "/", headers=HOST); assert s == 200, s
    html = raw.decode()
    srcs = re.findall(r'<script[^>]*\ssrc="([^"]+)"', html); css = re.findall(r'<link rel="stylesheet" href="([^"]+)"', html)
    dups = sorted({x for x in srcs if srcs.count(x) > 1}); assert not dups, f"duplicate scripts {dups}"
    bad = [a for a in srcs + css + ["favicon.ico", "favicon.svg", "privacy.html"] if http(PRIME + "/" + a, headers=HOST)[0] != 200]
    assert not bad, f"missing assets {bad}"
    csp = h.get("Content-Security-Policy", ""); assert "cloudflareinsights" in csp and "frame-src 'self'" in csp, "CSP"
    assert http(PRIME + "/", "HEAD", headers=HOST)[0] == 200, "HEAD /"
    return f"{len(srcs)} scripts + {len(css)} stylesheets served once, HEAD ok, CSP ok"

def prime_gating():
    out = []
    for path in ("/api/prime/models", "/api/prime/adk/health", "/api/prime/bots/health", "/api/prime/browser/status", "/api/prime/uploads/list", "/api/prime/build/health", "/api/workspace/fleet"):
        s, _, _ = http(PRIME + path, headers={**HOST, "x-prime-request": "1"})
        out.append(s); assert s in (401, 403), f"{path} answered {s} without a session"
    return f"7 owner routes refuse an anonymous caller ({sorted(set(out))})"

def qwen():
    s, _, raw = http("http://127.0.0.1:11441/api/ps"); assert s == 200, s
    models = json.loads(raw).get("models", []); names = [m.get("name") for m in models]
    assert any("qwen38" in (n or "") for n in names), names
    return f"loaded: {names}"

def adk_health():
    s, _, raw = http(ADK + "/health"); h = json.loads(raw); assert s == 200 and h.get("profile") == "ECHO_ADK", h
    return h

def adk_run():
    s, _, raw = http(ADK + "/runs", "POST", {"agent": "forge-steward", "prompt": "Report the health of node forge in one sentence using your capabilities."})
    assert s == 202, (s, raw[:200]); run_id = json.loads(raw)["run_id"]
    deadline = time.time() + 300
    while time.time() < deadline:
        r = json.loads(http(ADK + f"/runs/{run_id}")[2])
        if r["status"] in ("done", "failed", "gated"): break
        time.sleep(4)
    kinds = [st.get("kind") for st in r.get("steps", [])]
    final = next((st for st in r.get("steps", []) if st.get("kind") == "final"), None)
    answered = next((st.get("data", {}).get("answered") for st in r.get("steps", []) if st.get("kind") == "model"), None)
    proof = r.get("proof") or {}
    assert r["status"] == "done" and proof.get("verdict") == "PASS", {"status": r["status"], "error": r.get("error"), "kinds": kinds, "proof": proof.get("verdict")}
    return {"run": run_id[:8], "steps": kinds, "answered_by": answered, "proof": proof.get("verdict"), "final": (final or {}).get("data", {}).get("text", "")[:160]}

def bots_lifecycle():
    s, _, raw = http(ADK + "/bots", "POST", {"name": "e2e-probe", "agent": "forge-steward", "daily_cost_cap_usd": 0})
    assert s == 201, (s, raw[:200]); bot = json.loads(raw); bid = bot["bot_id"]; assert bot["status"] == "paused", bot["status"]
    try:
        s, _, raw = http(ADK + f"/bots/{bid}/message", "POST", {"text": "Say hello in five words."}); assert s == 202, (s, raw[:200])
        assert json.loads(http(ADK + f"/bots/{bid}/resume", "POST", {})[2])["status"] in ("idle", "running")
        deadline = time.time() + 240; msgs = []
        while time.time() < deadline:
            msgs = json.loads(http(ADK + f"/bots/{bid}/messages")[2]).get("messages", [])
            if any(m.get("role") == "bot" for m in msgs): break
            time.sleep(4)
        reply = next((m["text"] for m in msgs if m.get("role") == "bot"), None); assert reply, f"no bot reply ({len(msgs)} messages)"
        assert json.loads(http(ADK + f"/bots/{bid}/pause", "POST", {})[2])["status"] == "paused"
    finally:
        http(ADK + f"/bots/{bid}", "DELETE")
    assert http(ADK + f"/bots/{bid}")[0] == 404, "bot still present after delete"
    return {"created": "paused", "reply": reply[:120], "deleted": True}

def workspace_plugins():
    out = subprocess.run(["systemctl", "is-active", "echo-workspace-web"], capture_output=True, text=True).stdout.strip(); assert out == "active", out
    s, _, raw = http("http://127.0.0.1:8775/api/health"); assert s in (200, 401), s
    return "echo-workspace-web active; /api/health owner-gated" if s == 401 else json.loads(raw)

def browser_relay():
    s, _, raw = http("http://127.0.0.1:9780/rpc", "POST", {"type": "ping"}, timeout=10); d = json.loads(raw)
    assert s == 200 and d.get("ok"), d; return d.get("data", {}).get("version")

def swarm_worker():
    s, _, raw = http("http://127.0.0.1:8358/health"); d = json.loads(raw); assert s == 200, s
    return {k: d.get(k) for k in ("ready", "profile", "active_runs") if k in d}

def gate():
    s, _, raw = http("http://127.0.0.1:8000/sdk/health", timeout=20); assert s == 200, s; return "gate ok"

for name, fn in [("prime assets + CSP + HEAD", prime_assets), ("prime owner gating", prime_gating), ("qwen 3.8 256K loaded", qwen),
                 ("echo-adk-api health", adk_health), ("echo-adk real run with proof", adk_run), ("echoBots lifecycle", bots_lifecycle),
                 ("workspace backend", workspace_plugins), ("shadowglass relay via tunnel", browser_relay), ("maximalist swarm worker", swarm_worker),
                 ("SDK gate", gate)]:
    check(name, fn)
print("SUMMARY " + json.dumps({"passed": sum(r["ok"] for r in RESULTS), "total": len(RESULTS)}))
json.dump(RESULTS, open("/tmp/prime-e2e-results.json", "w"), indent=1)
sys.exit(0 if all(r["ok"] for r in RESULTS) else 1)
