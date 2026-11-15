'use strict';
(() => {
  class Ledger {
    constructor() { this.chats = new Map(); }
    ingest(chatId, event, historical = false) {
      if (!chatId) return;
      let data = event;
      try { if (typeof event.content === 'string') data = JSON.parse(event.content); } catch { return; }
      const kind = event.kind || event.type;
      const manual = ['action_receipt', 'action_failed'].includes(kind) && (data.action || data.request?.action) === 'esh';
      if (!manual && !(['tool_started', 'tool_result'].includes(kind) && data.tool === 'esh')) return;
      const id = data.request_id || data.request?.request_id || event.id;
      if (!id) return;
      if (!this.chats.has(chatId)) this.chats.set(chatId, new Map());
      const rows = this.chats.get(chatId), previous = rows.get(id) || {};
      const result = kind === 'action_failed' ? {ok: false, error: data.error, state: 'unconfirmed'} : data.result;
      const started = kind === 'tool_started';
      const status = started ? (previous.result ? previous.status : historical ? 'unconfirmed' : 'running') :
        result?.verdict === 'gated' ? 'gated' :
        result?.state === 'unconfirmed' || result?.state === 'unknown' ? 'unconfirmed' :
        result?.ok === false || result?.error || (result?.exit != null && result.exit !== 0) ? 'failed' : 'complete';
      rows.set(id, {...previous, id, command: data.arguments?.command || data.request?.command || previous.command || '',
        source: manual ? (previous.source || 'You') : (previous.source || 'Echo'), status,
        result: result || previous.result, created: previous.created || event.created || ''});
    }
    rows(chatId) { return [...(this.chats.get(chatId)?.values() || [])]; }
  }
  const node = (tag, cls, text) => {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text != null) element.textContent = text;
    return element;
  };
  function mount({host, api, getChat, ensureChat, onUpdated}) {
    const ledger = new Ledger();
    let chatId = null, manualBusy = false, expanded = false, large = false;
    try { expanded = localStorage.getItem('echo.esh.open') === 'true'; } catch {}
    host.className = 'esh-dock';
    const toggle = node('button', 'esh-toggle');
    toggle.type = 'button'; toggle.id = 'esh-toggle'; toggle.setAttribute('aria-controls', 'esh-body');
    const mark = node('span', 'esh-mark', '>_'), label = node('strong', '', 'ESH');
    const status = node('span', 'esh-status', 'Ready'), chevron = node('span', 'esh-chevron');
    toggle.append(mark, label, node('span', 'esh-caption', 'Echo’s shell'), status, chevron);
    const body = node('section', 'esh-body'); body.id = 'esh-body'; body.setAttribute('aria-label', 'ESH terminal');
    const toolbar = node('div', 'esh-toolbar');
    const location = node('span', '', 'QUENCH · PowerShell · current chat');
    const resize = node('button', 'quiet', 'Expand'), close = node('button', 'quiet', 'Close');
    resize.type = close.type = 'button'; close.setAttribute('aria-label', 'Close ESH panel');
    toolbar.append(location, resize, close);
    const output = node('div', 'esh-output'); output.id = 'esh-output'; output.setAttribute('aria-label', 'ESH command history');
    const form = node('form', 'esh-command-form');
    const command = node('textarea', 'esh-command'); command.id = 'esh-command'; command.rows = 1;
    command.maxLength = 8000; command.placeholder = 'Run a command…  Ctrl+Enter';
    command.setAttribute('aria-label', 'ESH command'); command.spellcheck = false;
    const run = node('button', 'primary', 'Run'); run.type = 'submit'; run.id = 'esh-run';
    form.append(node('span', 'esh-prompt', 'PS >'), command, run);
    const hint = node('small', 'esh-hint', 'Echo uses this same shell autonomously. Output appears when a command finishes. Receipts stay with this chat.');
    body.append(toolbar, output, form, hint); host.replaceChildren(toggle, body);
    function setOpen(value) {
      expanded = value; body.hidden = !value; toggle.setAttribute('aria-expanded', String(value));
      chevron.textContent = value ? '⌄' : '⌃'; host.classList.toggle('open', value);
      try { localStorage.setItem('echo.esh.open', String(value)); } catch {}
    }
    toggle.addEventListener('click', () => setOpen(!expanded));
    close.addEventListener('click', () => { setOpen(false); toggle.focus(); });
    resize.addEventListener('click', () => { large = !large; host.classList.toggle('large', large); resize.textContent = large ? 'Reduce' : 'Expand'; });
    function render() {
      const rows = ledger.rows(chatId), last = rows.at(-1), running = rows.some(row => row.status === 'running');
      status.textContent = running ? 'Working…' : last ? ({complete: 'Complete', failed: 'Needs attention', gated: 'Needs authorization', unconfirmed: 'Unconfirmed'}[last.status] || 'Ready') : 'Ready';
      status.classList.toggle('working', running);
      output.replaceChildren();
      if (!rows.length) output.append(node('p', 'esh-empty', 'Shell commands from you and Echo will appear here.'));
      for (const row of rows.slice(-100)) {
        const entry = node('article', 'esh-entry ' + row.status);
        const head = node('div', 'esh-entry-head');
        const result = row.result;
        head.append(node('span', '', row.source), node('span', '', row.status + (result?.exit != null ? ' · exit ' + result.exit : '')));
        entry.append(head, node('pre', 'esh-command-text', 'PS > ' + (row.command || 'Command receipt')));
        if (result) {
          if (result.stdout) entry.append(node('pre', 'esh-stdout', result.stdout));
          if (result.stderr) entry.append(node('pre', 'esh-stderr', result.stderr));
          if (result.error || result.reason) entry.append(node('p', 'esh-stderr', result.error || result.reason));
          if (!result.stdout && !result.stderr && !result.error && !result.reason) entry.append(node('span', 'esh-no-output', 'No text output.'));
          const receipt = node('details', 'esh-receipt');
          receipt.append(node('summary', '', 'Receipt' + (result.audit_id ? ' · ' + result.audit_id : '')), node('pre', '', JSON.stringify(result, null, 2)));
          entry.append(receipt);
        } else entry.append(node('span', 'esh-no-output', row.status === 'running' ? 'Waiting for the execution receipt…' : 'No final receipt recorded. Check before retrying.'));
        output.append(entry);
      }
      output.scrollTop = output.scrollHeight;
      run.disabled = manualBusy; command.disabled = manualBusy; run.textContent = manualBusy ? 'Running…' : 'Run';
    }
    async function execute(event) {
      event.preventDefault();
      if (manualBusy || !command.value.trim()) return;
      manualBusy = true;
      let id, requestId, text = command.value.trim();
      try {
        id = await ensureChat(); chatId = id; requestId = crypto.randomUUID();
        ledger.ingest(id, {type: 'tool_started', tool: 'esh', request_id: requestId, arguments: {command: text}});
        ledger.chats.get(id).get(requestId).source = 'You'; command.value = ''; render();
        const result = await api('/api/action', {action: 'esh', command: text, chat_id: id, request_id: requestId});
        ledger.ingest(id, {type: 'tool_result', tool: 'esh', request_id: requestId, result});
        await onUpdated(id);
      } catch (error) {
        if (id && requestId) ledger.ingest(id, {type: 'tool_result', tool: 'esh', request_id: requestId, result: {ok: false, state: 'unconfirmed', error: error.message}});
        else { command.value = text; status.textContent = error.message || 'Could not start'; }
      } finally { manualBusy = false; render(); }
    }
    form.addEventListener('submit', execute);
    command.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { execute(event); } });
    function sync(chat = getChat()) {
      chatId = chat?.id || null;
      for (const event of chat?.events || []) ledger.ingest(chatId, event, true);
      render();
    }
    function receive(id, event) { ledger.ingest(id, event); if (id === chatId) render(); }
    setOpen(expanded); sync();
    return {sync, receive, setOpen, ledger};
  }
  window.EchoEshPanel = {Ledger, mount};
})();
