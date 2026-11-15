# echoBots — design and Grok Bot parity (2026-11-04)

Status: **research + design for the lead** (Commander order 2026-11-04). Nothing here changes the frozen contract; §4 lists what the contract does not cover yet. Every Grok fact carries a dated source tag resolved in §0; claims resting on one third-party page are marked **[single-source]**, numbers reported by xAI about itself are marked **[xAI self-reported]**. Pages fetched 2026-11-04.

Reference documents this design maps onto:

- **[E1]** `ECHO_ADK_API_CONTRACT.md` (v1, frozen 2026-11-04) — `QUENCH-prime-parity-20261104/docs/echo-code/`. Line refs below are to that file.
- **[E2]** `ECHO_ADK_SPEC_DRAFT.md` (v0) — `QUENCH-echo-adk-research/docs/echo-adk/`. §/R refs below are to that file.
- **[E3]** Commander order 2026-11-04 (this task): per-bot Lease with exact cap ids, ESH for any shell, per-bot Crystal/ECF scope, no tokens, Echo nodes only, start paused, per-bot cap <= 5 USD/day, fleet caps 50/200 USD, no shared computer or credentials.

---

## 0. Sources

**Primary (xAI / SpaceXSI pages, fetched):**

| Tag | Page | Date |
|---|---|---|
| P1 | https://x.ai/news/introducing-grok-bot | Aug 11, 2026 |
| P2 | https://x.ai/news/grok-bot-more-plans | Aug 26, 2026 |
| P3 | https://x.ai/news/team-bots | Sep 28, 2026 |
| P4 | https://x.ai/news/data-bot | Nov 2, 2026 |
| P5 | https://docs.x.ai/grok-bot/overview | fetched 2026-11-04 (undated page) |
| P6 | https://docs.x.ai/grok-bot/bots | fetched 2026-11-04 |
| P7 | https://docs.x.ai/grok-bot/faq | fetched 2026-11-04 |
| P8 | https://docs.x.ai/grok-bot/approvals-security-and-privacy | fetched 2026-11-04 |
| P9 | https://docs.x.ai/grok-bot/teams-and-enterprises | fetched 2026-11-04 |

**Third-party (fetched; vendors of competing or adjacent products are noted):**

| Tag | Page | Date / note |
|---|---|---|
| T1 | https://composio.dev/content/guide-to-frok-bot | Aug 20, 2026 — Composio sells a Grok Bot plugin |
| T2 | https://www.digitalapplied.com/blog/grok-bot-ai-teammates-launch-cloud-computer-2026 | Aug 11, 2026 |
| T3 | https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/ | Aug 12, 2026 |
| T4 | https://www.unite.ai/xai-launches-grok-bot-always-on-ai-teammates-with-their-own-cloud-computers/ | Aug 11, 2026 |
| T5 | https://cellcog.ai/blog/grok-team-bots/ | Sep 28, 2026 (updated Oct 27) — CellCog sells "AI employees" |
| T6 | https://www.unite.ai/xai-introduces-data-bot-to-bring-shared-analytics-skills-to-grok-bot/ | Nov 2, 2026 — credited to an AI research agent, editor-reviewed |
| T7 | https://beam.ai/agentic-insights/grok-bot-enterprise-ai-agents | header Aug 27, metadata Nov 3, 2026 — Beam sells a governed-agent platform |
| T8 | https://www.eesel.ai/blog/grok-bot-review | last edited Aug 12, 2026 |

**Not reachable on 2026-11-04:** `https://x.ai/changelog/bot` (HTTP 403), `https://docs.x.ai/grok-bot/routines` and `/skills` (HTTP 404). Claims that only appeared in search-engine summaries (routine types "hourly/interval/daily", Data Bot wired to Datadog/Statsig) are **excluded**; the fetched P4 page names only Databricks, Hex, Braze and Slack.

Company naming: the pages call the company xAI, SpaceXAI or SpaceXSI depending on date. This document says "xAI" throughout.

---

## 1. Grok Bot facts (dated)

### 1.1 What a Bot is

- "Grok Bot is your team of always-on agents." Launched in beta **Aug 11, 2026** [P1]. Began as "an internal prototype, and it took off across the company" — sales outbound, marketing campaigns, office operations, bug fixes [P1].
- "A Bot is a durable AI teammate with a name, a job, its own conversation, and working context that develops over time." [P6] Create a separate Bot when the work has a distinct goal, tools and sources, working style, approval boundary, or recurring schedule [P6].
- Bots "only come back when something needs your approval" [P1]; "Closing the app, laptop, or phone does not stop a background turn or routine." [P7]
- No paused state is documented for a Bot. Hiding "removes a Bot from the main list without deleting its work or pausing its routines" and "Hidden Bots stay active and keep their history." [P6] (Whether a freshly created Bot is "active" is not stated on any page fetched; the docs simply offer no pause.)

### 1.2 The "own cloud computer" model — and the documented contradiction

- Marketing (Aug 11): "Bots have their own computer." and "Bots share a computer of their own in the cloud, so jobs do not stall when you step away." [P1]
- Docs: "Each Bot works on a persistent cloud computer with a browser, filesystem, and terminal." then "All of your Bots use the same cloud computer." sharing "its files, browser sessions, and app logins" [P5]. "Bots have separate roles and conversations, but they share the computer." [P6]
- FAQ: "**The computer is assigned per user, not per Bot. Do not use separate Bots as a security boundary.**" [P7] Security page: "All of your Bots share one cloud computer assigned to your user account." and "Do not use separate Bots as a security boundary." [P8]; T2 quotes the same page: "Files, browser sessions, and command line credentials on that computer are available across your Bot roster." [P8 via T2].
- Owner guidance: "treat anything placed on it as available to every Bot you run"; "between users, isolation is strict." [P5]. "Do not treat this user assignment as a guarantee that is broader than Cursor's published security documentation." [P8] The computers run in Cursor's cloud [P5]; one isolated Linux machine per account [T3].
- Concurrency: each Bot has its own screen; "one Bot runs one computer-use task on its screen at a time." [P5]
- Shared/Team Bots: "In Slack channels, threads, group DMs, and group chats, a shared Bot uses one computer of its own." In a member's own chat it "usually works on that member's computer, uses that member's connected accounts after asking". [P9]
- Deletion: "This erases its profile, conversations, memory, routines, and attachments." "It can't be undone." but "Files and sign-ins on the shared computer aren't isolated per Bot and can remain there" [P6]; "Because Bots share a computer, files and logins on that computer may remain." [P7]. T2 calls this a soft delete.
- Local machine: "The default is Ask every time. Use Never allow unless a Bot has a specific reason to work on your local files." and "These settings do not prevent the Bot from using its cloud computer." [P8]

### 1.3 Credentials and secrets

- "Bots sign in and check out without seeing secret values." "Values from Vault and Secure Forms are filled into the page without being shown to the model." "Do not send a password, one-time code, or API key in ordinary chat." [P8]
- The Bot hands control to the human for SSO, passkeys, CAPTCHA, device approvals, card verification [P8]; a Vault card "fills in at checkout without a separate approval each time." [P8]
- "Logins, cards, and contact info, like addresses and phone numbers, belong in Vault, not in memory." [P6]
- Team Bots have **Credentials** that "let it securely access third-party APIs that do not have a plugin." [P3]; "Secrets, apps, and files the owner or a Manager adds to a shared Bot are available in every teammate's chat." [P9]
- Enterprise-only **Team Secrets**: env vars for Team Setup scripts, "They do not make a value available to Bots directly", "up to 100 secrets per team, up to 32 KB per value, and up to 96 KB in total." [P9]
- T3 reports the product's own framing of the shared computer as "a real blast radius" and its advice to disconnect plugins "when done" **[single-source]**.

### 1.4 Approvals and review

- "Allow once: the Bot does the action now. No rule is saved." "Deny: the Bot doesn't do it. It won't try that action again or ask you about it until you send another message." Always-allow rules exist; "If both kinds of rule match, Ask first wins." [P8]
- "Auto Review checks each action your Bot is about to take" [P8]; "Back safety boundaries with approvals and Auto-review rules rather than memory alone." [P6]
- Approval cards raised by "a routine, an incoming message, or other background work" expire after **30 minutes**; cards from a live chat wait [P8].
- Owners can require approval for sending, publishing, deleting, purchasing, changing production systems [T1]; iPhone offers only Approve once / Deny [T2] **[single-source]**.
- Complaints: no sandbox or dry run, a test run "performs real work"; per-action audit view listed as "coming" [T8] **[single-source]**; "no built-in audit trail", "consumer-grade permissions" [T7] **[single-source, competitor]**.

### 1.5 Group chats

- "You can also place Bots in a group chat where they can coordinate on their own." Bots "can independently message each other and share context in threads." [P1]
- "Put Bots in a group chat when the handoff itself needs to be visible." "The coordinator can assign work, while the group preserves the handoffs in one conversation." "Each Bot in a group keeps its own memory;" "everyone in the group can read what your Bot says." [P6]
- **Size 2 to 6 Bots:** reported by T1 ("Two to six Bots can be placed in a group chat") and T8 ("Group chats take two to six Bots"). **Not stated on any xAI page fetched** (P1, P5, P6, P7 give no number). Treat as third-party-reported; the contract's 2..6 [E1 L30] is therefore an Echo design choice, not verified parity.

### 1.6 Skills, plugins, routines, memory

- Skill vs routine: "A routine assigns a workflow to one Bot and tells it when to run—on a schedule or, where supported, after an event." [P7] A Bot can "save the path as a skill" and "rerun it on a schedule" [P5]; Bots "save your workflow as a routine, take your corrections, and run it on its own next time." [P1]
- "Teach a task" records a browser workflow and drafts a skill [T1, T2]; recordings capped at 10 minutes [T2] **[single-source]**.
- Connectors: "Use a connector when one is available for a more structured and reliable integration." [P7] Plugins/MCP: Bots use connectors, plugins and MCP servers; Marketplace under Settings → Plugins [T1]; the Bot self-reported a catalog of **220 plugins**, none installed by default; no HR/ITSM plugins found Aug 12 [T3] **[single-source]**.
- Memory: "Conversations and learned context stay separate per Bot." Bots retain "Stable preferences, role context, and summaries of prior work." A few owner facts "such as your name and time zone" are shared by all your Bots [P5, P6]. "**A Bot decides on its own when something is worth keeping. It doesn't ask first.**" "What a Bot saves in one chat, it remembers in all your chats with it." "Memory is not a source of truth" [P6]. Reset keeps memory; deleting a Bot deletes its memory [P6].
- Model: "Grok Bot picks the model for each task, and there is no model picker." [P7] No model named on any xAI page checked [T2]; "same Grok 4.5 lineage" [T8] **[single-source]**; router "wasn't great" in testing [T7] **[single-source, competitor]**.

### 1.7 Team Bots (Sep 28, 2026)

- "Today we're launching Team Bots, Grok Bots that work and learn alongside your team." Four components: **Context** ("the relevant files, instructions, and skills"), **Plugins** ("Salesforce, Notion, and GitHub"), **Credentials** ("securely access third-party APIs that do not have a plugin"), **Memories** ("retain what it learns and improve at its role over time") [P3].
- "Although the Bot is shared, each person's conversations with it remain private." [P3]; "Each member's chat is private, including from the owner and the Bot's Managers." [P9]
- "A shared Bot can save things it learns for the whole team, and it tells you when it does." "It doesn't save anything about you personally for the team." "A teammate's shared Bot doesn't get the facts your own Bots share about you." [P6]
- "Each Team Bot has its own handle, so you can invite it to a channel" (Slack) [P3]. Pre-built: Customer Bot (sales), EPD Teammate (PM), Marketing Bot, Data Bot [P3].
- Templates: "Adding a shared template creates a copy on the recipient's account." "They never get your computer, logins, or conversation history." Enterprise teams start with public template sharing off [P6, P9].
- Admin: "Manage Shared Bots" controls who can use each shared Bot; auto-added Bots cannot be hidden; deleting a shared Bot "removes it for everyone on the team, removes its Slack app, and cannot be undone." SSO/SCIM carry over from Cursor. Network controls (Enterprise only) restrict destinations team computers can reach; default allow-all; "Self-serve Teams cannot set this." [P9]
- "Team Bots is available today in public beta on Teams and Enterprise plans." Pricing: "Contact sales." [P3] Teams plan: "every member has access, and usage follows the seat's allowance" [P9].
- **[xAI self-reported]**: a five-person team shipped "more than 100 PRs a day" using Cloud Agents while building Team Bots [P3]; Harper CEO: "We built a Team Bot in 24 hours to automate this, saving our customers over $120,000 from hundreds of policies." [P3]. Rate limits "to prevent unintended changes at scale" [T5 citing an Oct 27 xAI case study] **[single-source]**.

### 1.8 Data Bot (Nov 2, 2026)

- "Data Bot is a Team Bot in Grok Bot that the data science team teaches." [P4] Shared skills: metrics and analysis, experiments, charts and dashboards, data engineering [P4]; T6 details them (metric definitions and source tables, A/B power analyses, chart conventions, Databricks/Hex dashboards, dbt model review, event-logging conventions).
- Tools named: Databricks, Hex, Braze, Slack [P4]; dbt [T6]. Credentials: Data Bot uses "shared, read-only credentials to query approved tables in Databricks." [P3, Sep 28].
- Memory governance: Data Bot proposes additions to shared memory; **Team Bot managers approve or reject them** before everyone sees them [P4, T6].
- Scheduling: "Data Bot can run that workflow on a schedule and contribute updates directly to the group conversation." (Slack weekly metric reports) [P4].
- **[xAI self-reported]**: "About 70 hours of work that would otherwise have landed on the data science team" in one week [P4]. "We still handle complex analyses that require more judgment." [P4]. No plan or price stated on P4.

### 1.9 Pricing, plans, limits, platforms (changed over time)

- Aug 11 / Aug 26: beta for SuperGrok, SuperGrok Plus, SuperGrok Heavy; Cursor Pro, Pro+, Ultra; Cursor Teams Standard and Premium; "Grok Bot comes with its own usage, separate from your Grok and Cursor plans."; Enterprise waitlist [P1, P2].
- Current docs: "it's included with Premium, Super, and Ultra, for individuals and team seats" on The X Subscription; "draws from the same weekly usage pool as Cursor and the Grok apps"; "Usage resets weekly."; "Super and Ultra include larger weekly pools than Premium."; "If on-demand is off, Grok Bot stops when weekly usage runs out and resumes when weekly usage resets." [P5, P7]. The Aug 26 "own usage" and the current "same weekly pool" statements differ by date — read as a product change, not an error.
- Third-party prices (no xAI price page fetched): Cursor Ultra $200/mo [T2, T4, T7, T8]; "Cursor Premium Teams" $120/seat/mo [T2, T4, T8] — T2 could not reconcile it with Cursor's $40 Teams price; SuperGrok Heavy $300/mo [T7 citing VentureBeat] **[single-source]**. No standalone Grok Bot price [T2]; no spend cap at launch [T8] **[single-source]**.
- Limits: weekly pool; T1's author hit the weekly limit mid-task and the agent stalled **[single-source]**; metering bugs and lockouts at launch [T8] **[single-source]**.
- Privacy: "Grok Bot requires cloud data storage, so Legacy Privacy Mode is not supported." "Training opt-out follows the applicable Cursor account and privacy settings." "All data is removed within 30 days." (on account deletion) [P7]. No SOC 2 / ISO / HIPAA claim on the Grok Bot docs themselves; they defer to Cursor's documentation [P8, T8]; Cursor reports SOC 2 Type II [T3].
- Platforms: at launch macOS, Windows, iPhone; Linux desktop, Android, iPad not supported [T2, T8]. Current docs: macOS, Windows, Linux desktop; iPhone (iOS 18+), iPad (iPadOS 18+), Android 9+ [P5, P7].

### 1.10 What users praise and complain about (all third-party)

- Praise: works in tools with no API or MCP, keeps running with the laptop closed, near-zero setup, candid "early beta" labelling [T8]; "truly amazed" by plain-English instructions [T1]; "a genuinely capable product" [T7].
- Complaints: no dry run / sandbox, approvals do not reverse completed work, audit view "coming", metering bugs, high token cost for always-on agents [T8]; weekly limit reached quickly in multi-bot setups, CAPTCHAs and blocked browser automation [T1]; backend model routing with no override, no enterprise control layer, individual subscriptions bypass procurement ("shadow IT with the ability to take actions") [T7]; shared computer is "a real blast radius" [T3].

---

## 2. Parity table — Grok Bot → echoBots

Cells cite §0 tags; "Where it lives" cites the contract [E1] by line and the spec [E2] by section/invariant. **Gap** = not yet in the contract (see §4).

| Feature | Grok Bot behaviour | echoBots behaviour | Where it lives |
|---|---|---|---|
| Unit | Durable named teammate: name, job, own conversation, growing context [P6] | `Bot {bot_id, name, agent, mode, status, ...}`; the job is an EchoAgent definition | E1 L23; E2 §2 EchoAgent |
| Creation state | No paused state documented; hiding does not pause routines [P6] | `POST /bots` → `201` with `status:"paused"`; owner resumes | E1 L25–26 |
| Compute substrate | One cloud computer per user in Cursor's cloud, shared by all Bots [P5, P7, P8]; Linux per T3/T8 | No computer. Each turn is a run on Echo nodes (FORGE/ANVIL lane) under the bot's Lease | E1 L31; E2 §2 Lane, R1 |
| Isolation claim | "Do not use separate Bots as a security boundary" [P7, P8] | Each bot IS a boundary: own Lease, own memory scope, no shared state | E1 L23 lease/memory, L31; E2 R3 |
| Shell / terminal | Shared terminal; CLI credentials visible to every Bot [P8 via T2] | Shell only via ESH, tier-classified, `kind:"shell"` envelope, ledger `audit_id` | E2 §3, §4, R5; E3 |
| Browser / computer use | Chrome on the shared VM, one task per Bot screen [P5] | **Gap**: no browser lane in contract | §4 B5 |
| Files | Shared filesystem; files outlive Bot deletion [P6, P7] | **Gap**: messages are text-only; artifacts only via `kind:"artifact"` envelope | E1 L28; E2 §3; §4 B4 |
| Credentials | Vault fills secrets into pages unseen by the model; shared across the roster [P8] | Bots never hold tokens; caps run through the broker; env drops `KEY/TOKEN/SECRET` | E1 L31, L35; E2 R1 |
| Skills / plugins | Skills (incl. taught) [P5, T1]; connectors, plugins, MCP [P7, T1]; ~220 plugins [T3, single-source] | `plugins:[skill names]` = Agent-Skills dirs; tools = exact cap ids only | E1 L23; E2 §2 Skill/Capability, §6 skills |
| Tool authority | Team Bot plugins/credentials shared with every teammate's chat [P3, P9]; per-person or per-team install [T5] | `lease.scopes` = exact cap ids, `max_uses`, `ttl_s`; no `*` | E1 L14, L23; E2 R3 |
| Memory (personal) | Per-Bot memory; Bot decides alone what to keep; not a source of truth [P5, P6] | Crystal/ECF writes only under `memory.scope:"bot:<bot_id>"`, `kind:"memory"` envelope | E1 L23, L31; E2 §6 EchoMemoryService |
| Memory (team) | Shared Bot saves for the team and says so; Data Bot memories need Manager approval [P6, P4] | **Gap**: `mode:"team"` has no defined memory semantics | §4 B1 |
| Owner facts across bots | Name and time zone shared by all your Bots [P5, P6] | Not shared; scope is bot-only | E1 L23; §4 B11 |
| Scheduling | Routine on a schedule; runs with devices closed [P5, P7] | `schedule:{every_s >= 60}` or `null`; each tick is a run | E1 L23, L25 |
| Event triggers | "where supported, after an event" [P7] | **Gap**: interval only | §4 B2 |
| Always-on | 24/7; returns only for approval [P1] | Runs continue server-side; `status` idle/running; `gated` run waits for a Lease | E1 L15, L23 |
| Messaging | Chat per Bot; iOS and desktop [P1] | `POST /bots/{id}/message` → `202 {message_id, run_id}`; paused bot answers on resume | E1 L28–29 |
| Group chats | Bots coordinate, hand off, assign ownership; 2–6 per T1/T8 only [P1, P6] | `POST /groups {bots x2..6, prompt}` → run per bot; `GET /groups/{id}` messages + summary | E1 L30 |
| Approvals | Allow once / Deny / Always allow; Auto Review; "Ask first wins"; 30-min expiry for background cards [P8] | `verdict:"gated"` with `needs`/`how`; owner mints a Lease; default-deny | E1 L7, L16; E2 §3, R5 |
| Model choice | Backend picks the model; no picker [P7] | Lane model fixed per agent; `data.answered` reports the real model; no reroute | E1 L12, L16; E2 R2 |
| Audit | Per-action audit view "coming" [T8]; no built-in trail [T7] | Every run emits `Proof {events_sha256, actions[], verdict}` | E1 L17; E2 §2 Proof, R4 |
| Cost / usage | Weekly pool shared with Cursor/Grok apps; overage at token cost [P5, P7, T8] | `daily_cost_cap_usd <= 5`, `spent_today_usd`; `budget_exceeded` error; fleet 50/200 USD | E1 L7, L23, L25; E3 |
| Stop / pause | Hide keeps routines running; no pause verb documented [P6] | `pause` / `resume`; `POST /runs/{id}/stop` after current step | E1 L18, L26 |
| Delete | Erases profile/memory/routines; files and logins may remain on the shared computer [P6, P7] | `DELETE /bots/{id}` after UI confirm; nothing survives because nothing is shared | E1 L27, L31 |
| Team mode / sharing | Shared Bot: team context, plugins, credentials, skills; private per-member chats [P3, P9] | `mode:"team"` exists; behaviour undefined | E1 L23; §4 B1 |
| Templates | Copy to recipient; never copies computer, logins, history [P6] | **Gap**: EchoAgent YAML is data, so template = agent YAML + bot config minus lease/memory | E2 §2, §7; §4 B8 |
| External surfaces | Slack handle per Team Bot; iOS/Android apps [P3, P5] | Prime echoBots panel only (owner-classified routes) | E1 L37; §4 B7 |
| Data analytics | Data Bot: read-only Databricks creds, approved tables, Hex dashboards, Slack reports [P3, P4] | **Gap**: no analytics caps or approved-table allowlist | §4 B6 |
| Network egress | Enterprise-only network controls; default allow-all [P9] | **Gap**: no per-bot egress policy; gate caps are the only reach | §4 B9 |
| Local machine | "Ask every time" default; cloud computer unaffected [P8] | echoBots never touch the owner's machine; loopback service only | E1 L3, L35 |
| Retention / privacy | Cloud storage required; Legacy Privacy Mode off; data removed within 30 days of account deletion [P7] | **Gap**: contract silent on retention of runs/messages | §4 B10 |
| Contract test | n/a | `tests/test_contract.py` + `tests/prime-bots.test.ts` against a stand-in | E1 L38 |

---

## 3. Deliberate divergences (stated plainly)

Format: Grok does → echoBots does → enforced at.

1. **Capability authority.** Grok: a Bot reaches whatever the shared computer and installed plugins can reach [P5, P8]. echoBots: a per-bot **Lease** listing **exact capability ids**, `max_uses`, `ttl_s`; no wildcards. → E1 L23; E2 R3 + SOL `validate_broker_token`.
2. **Shell.** Grok: shared terminal with shared CLI credentials [P8 via T2]. echoBots: **any shell step goes through ESH**, tier-classified, signed grant for tier >= 2, ledger `audit_id` on every envelope. → E2 §3 `kind:"shell"`, §4, R5; E3.
3. **Memory scope.** Grok: per-Bot memory plus owner facts shared across Bots; the Bot "decides on its own" what to keep [P5, P6]. echoBots: Crystal/ECF writes only under `memory.scope:"bot:<bot_id>"`; no cross-bot owner facts; every write is a `kind:"memory"` envelope in the run. → E1 L23, L31; E2 §6.
4. **Tokens.** Grok: Vault fills credentials into pages for the Bot; Team Credentials are shared by every teammate's chat [P8, P9]. echoBots: **bots never hold tokens**; Prime never forwards credentials; the service takes one broker token from systemd env; child env drops `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL`. → E1 L35; E2 R1.
5. **Substrate.** Grok: one Cursor-cloud Linux VM per user [P5, P7, T3]. echoBots: **no VM**; each turn is a run on Echo's own nodes (FORGE/ANVIL lane) and nothing persists outside Postgres, Crystal/ECF and the ledger. → E1 L31; E2 §2 Lane; E3.
6. **Start state.** Grok: no paused state is documented; hidden Bots keep running routines [P6]. echoBots: **`status:"paused"` on create**; the owner resumes; a paused bot still queues messages. → E1 L25, L28.
7. **Cost.** Grok: weekly usage pool, overage at token cost, no spend cap at launch [P5, P7, T8]. echoBots: **`daily_cost_cap_usd <= 5` per bot**, `spent_today_usd` visible, `budget_exceeded` stops the run. The order [E3] adds, verbatim, "fleet caps 50/200 USD" — it does not say per day or soft/hard. Two readings: (a) an echoBots fleet daily cap of 50 USD counted inside the existing CLAUDE.md HARD LIMIT of 200 USD daily cumulative (which also sets 50 USD per transaction); (b) 50 soft / 200 hard per day for echoBots alone. Reading (a) matches the doorway's existing figures; the lead confirms. Neither is in the contract yet (§4 B0). → E1 L7, L25; E3.
8. **No shared computer or credentials.** Grok: "Do not use separate Bots as a security boundary" [P7, P8]. echoBots: **each bot is a security boundary** — own Lease, own memory scope, own runs; groups exchange messages, never state. → E1 L31.
9. **Memory promotion is never autonomous** (earned by research). Grok personal Bots save without asking [P6]; Grok Data Bot needs Manager review [P4]. echoBots: every memory write is an envelope in the Proof; team-scope promotion (when built, §4 B1) requires an owner verdict. → E2 §3, R4.
10. **Deletion is complete.** Grok: files and logins may remain on the shared computer after delete [P6, P7]. echoBots: `DELETE` removes the bot, its memory scope and schedule; there is no shared machine to leave residue on. → E1 L27, L31.
11. **No local-machine reach.** Grok: local access defaults to "Ask every time" and the cloud computer is unaffected [P8]. echoBots: the service is loopback-only and runs on Echo nodes; a bot cannot be pointed at the owner's workstation. → E1 L3, L35.

---

## 4. Backlog — gaps the contract does not cover (prioritised)

One-line acceptance each. P0 = blocks "team" or Commander-mandated behaviour; P1 = Grok-parity features users will expect first; P2 = governance completeness; P3 = polish.

| # | Pri | Gap | Acceptance |
|---|---|---|---|
| B0 | P0 | Fleet-wide cost caps — order says "fleet caps 50/200 USD" [E3]; see divergence 7 for the two readings | `GET /health` reports `fleet_spent_today_usd`; a run that would push the echoBots fleet past 50 USD today fails `budget_exceeded` with `scope:"fleet"`; echoBots spend is counted inside the existing 200 USD daily cumulative limit (CLAUDE.md HARD LIMITS), or, if the lead picks reading (b), 200 becomes the hard fleet stop and 50 the warning that posts a `system` message to every bot owner |
| B1 | P0 | `mode:"team"` has no semantics (shared skills, private per-member threads, memory promotion) | Team bot answers two owners from `memory.scope:"bot:<id>"` plus per-member `thread:<user>` scopes; a proposed team memory is `gated` until an owner `POST /bots/{id}/memory/{mid}/approve` |
| B2 | P0 | Event triggers (Grok: "after an event" [P7]) — only `every_s` today | `schedule.on:[{source:"ecf.capture"\|"esh.msg"\|"webhook", filter}]` queues one run per matching event; contract test proves one trigger end to end |
| B3 | P1 | Wall-clock schedules (`every_s` cannot express "09:00 CT weekdays") | `schedule.cron:"0 9 * * 1-5"` with `tz`; next-run shown in `Bot.next_run_at` |
| B4 | P1 | File drops on messages (Grok shares files via the VM [P5]) | `POST /bots/{id}/message` accepts `attachments:[artifact_id]` from a prior `kind:"artifact"` envelope or an owner upload <= 8 MiB; bot reads via `echo.fs.read` under Lease |
| B5 | P1 | Browser / computer-use lane (Grok's main selling point [P1, P5]) | A `kind:"cap"` step may call a Playwright/Chromium worker cap with an **ephemeral profile created and destroyed per run**; no cookie, download or login persists across runs. **ShadowGlass (`claude.shadowglass.*`) is excluded** — it is the Commander's persistent signed-in Chrome, and handing it to a bot recreates Grok's shared-logins failure (divergences 4 and 8) |
| B6 | P1 | Data Bot analytics (read-only warehouse, approved tables, charts, scheduled reports [P3, P4]) | An `analytics` plugin: `echo.psql.query` restricted by an approved-table allowlist in the Lease, chart emitted as `kind:"artifact"`, weekly schedule posts the artifact as a `system` message |
| B7 | P2 | External surfaces (Grok: Slack handle per Team Bot [P3]) | A bot can be bound to one Telegram/Discord handle; inbound text becomes `POST /bots/{id}/message`; replies carry the `run_id` |
| B8 | P2 | Templates / sharing (Grok copies the Bot, never its computer or logins [P6]) | `GET /bots/{id}/template` returns agent YAML + bot config with `lease`, `memory`, `spent_today_usd` stripped; `POST /bots` accepts it |
| B9 | P2 | Per-bot network egress (Grok: Enterprise-only, default allow-all [P9]) | Lease carries `egress:[host allowlist]`; shell and browser steps outside it return `denied` |
| B10 | P2 | Retention statement (Grok: data removed within 30 days of account deletion [P7]) | Contract states run/message retention (proposal: 90 days, Proof forever) and `DELETE /bots/{id}` purges messages within 24 h |
| B11 | P2 | Opt-in owner facts across bots (Grok shares name/time zone [P5]) | `memory.scope:"owner:<user>"` read-only to all bots of that owner, written only by the owner from the panel |
| B12 | P3 | Gated-step expiry (Grok: background approval cards expire after 30 min [P8]) | A `gated` run with no Lease after `gate_ttl_s` (default 1800) fails `gated_expired`; schedules skip, not pile up |
| B13 | P3 | Hide vs pause (Grok hides without pausing [P6]) | `Bot.hidden:boolean` filters the panel list only; `status` unchanged |
| B14 | P3 | Proof rendering in the Prime echoBots panel | Each bot turn shows `actions[]` with cap, tier, verdict, `audit_id`; `events_sha256` copyable |

---

## 5. UI copy — "How echoBots differ from Grok Bots"

> echoBots are always-on agents that run on Echo's own nodes, not on a vendor cloud computer. Each bot holds a Lease that names the exact capabilities it may use, writes memory only under its own scope, never sees a credential, and runs any shell command through ESH with a signed audit trail. Grok Bots on one account share a single computer, its files and its logins — xAI's own docs say not to treat separate Bots as a security boundary; echoBots are built so each bot *is* one. New bots start paused and carry a daily cost cap (5 USD or less), so nothing runs or spends until you say so. Every turn produces a Proof you can inspect.

---

*Prepared by the fleet researcher lane for SOL mission sol-20261104062711-b0c5ba342c. Facts current to 2026-11-04; re-verify P5–P9 before quoting, since docs.x.ai pages are undated and have already changed once (usage pool, platforms) between Aug 11 and Nov 4.*
