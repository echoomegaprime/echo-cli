# Echo Prime task board — 2026-11-04 (Commander orders, checked off as they land live)

Live = merged into `agent/prime-workspace-parity-20261104`, gates green, deployed to FORGE and serving at echoomegaprime.com. PR #8 stays a draft.

## Landed live
- [x] Prime live at echoomegaprime.com from FORGE (b4508f7, 17:38 CST), 401-storm hotfix
- [x] echo-adk-api ↔ Prime contract frozen (4ec3cd8) + scoped gate key and port 8378 on FORGE
- [x] Agents (Echo ADK) view (fd46404)
- [x] echoBots view with Grok Bot divergences (77ac5a1) + echoBots design doc
- [x] Projects, Library, SDK (invoke), Vault, Code review views, `ui_action` navigation (4eaa8eb)
- [x] Chat surface actions, layout system, ESH dock, import, password recovery, allowlist cleanup (5835ac2)
- [x] Missed-abilities sweep doc (00de603) — P0 forwarded to ops
- [x] Deployed 21afd80 (20:36 CST)

## In flight (agent → slice)
- [ ] echo-adk repo + `echo-adk-api` service (Python core, bots, mcp/a2a/adk adapters, POST/PUT/DELETE /agents) → then deploy on FORGE :8378 and add `adk`/`bots` to prime.prod.json
- [ ] FORGE ops: #49859 prod Workspace config (plugins ESH/ECF/Personality/Crystal, voice freeman, mission, tool rounds, internet, Telegram approvals), favicon, HEAD 404, CSP, session-read cache, Cloudflare dashboard (www→apex, analytics injection), picker "unavailable" root cause
- [ ] Argon into the 40-seat swarm brain via Vertex service account (#49854)
- [ ] Side panel grouped nav, brilliant ECHO PRIME wordmark, sign-in card, clear Sign in / Sign up / Sign out buttons
- [ ] Echo talks: spoken replies on by default, ConvAI pipeline (sentence streaming, barge-in, orb sync), freeman voice
- [ ] In-chat browser via ShadowGlass relay (QUENCH→FORGE reverse tunnel), owner-only, approval when Echo drives
- [ ] All nodes connected (fleet probes fixed to run from FORGE; truthful reasons; CRUCIBLE dormant)
- [x] Compact mobile activity timeline + root cause of "ended without completion" (server saved the reply; client now reads it back on a dropped stream) + duplicated sentence (a91e791)
- [ ] Living orb: states, colour swirl on deep thinking, satellites = agents/bots, electrical arcs when busy
- [ ] Media auto-router (best model/tool from a bare prompt) + ✨ Enhance prompt (chat/image/video/music/sfx/voice via Claude/GPT/Gemini/Grok)
- [ ] Brain: truthfulness layer, auto model routing (coding→Claude, long-context→Gemini, research→Grok, refusal→Qwen labelled), Personality Forge auto-select, bloodline directive block
- [ ] Live internet + Wolfram + knowledge APIs + skills + MCP plugins for every model turn
- [x] Echo autonomously creates ADK agents + echoBots from prompts (c73db73; chat-loop wiring lands with the tools/brain slices)

## Ordered 20:37–20:42, starting now (wrapper-built: GPT/Codex, Grok CLI, Gemini/agy)
- [ ] Echo Build: real builds (full apps, programs, websites) from a prompt, not pages — repo per build, scaffold, data+auth, deploy, browser QA, hibernate/revive (reference: Grok workspace export)
- [ ] Video agent builder: multi-prompt, multi-input video production agents (storyboard → shots → generate → stitch → narration)
- [ ] Uploads (pictures, videos, documents, files) usable for image/video generation and Q&A; Library + Artifact Center
- [ ] Echo autonomous ESH + ECF use with hooks (prepare/capture/summaries) and in-chat fleet role switching
- [ ] Wrapper mandate: builders draft/build with GPT, Grok, Gemini; Claude reviews/integrates
- [ ] OpenClaw channel adapter + Telegram approvals (queued #echobots-openclaw-channel-approvals-20261104)

## Waiting on the Commander
- [ ] Keys/credits: SambaNova, Cerebras, NVIDIA NIM, Vertex express (or the new service account path), Copilot re-auth; OpenAI/OpenRouter/Cohere/Perplexity/Anthropic API credits; Wolfram Alpha app id (free tier at developer.wolframalpha.com)
- [ ] Device-code logins on FORGE for the CLI providers if the picker root cause turns out to be login state
