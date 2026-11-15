'use strict';
const $ = s => document.querySelector(s);
const state = {data: null, chat: null, view: 'chats', busy: false, project: '', attachments: new Set(), draft: ''};
const E = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
};
const B = (text, click, cls = '') => { const button = E('button', {type: 'button', class: cls}, text); button.addEventListener('click', async () => { if (button.disabled) return; button.disabled = true; try { await guarded(click); } finally { button.disabled = false; } }); return button; };
const field = (label, input, hint = '') => E('label', {class: 'field'}, E('span', {}, label), input, hint && E('small', {}, hint));
const input = (placeholder = '', value = '', type = 'text') => E('input', {placeholder, value, type});
const area = (placeholder = '', value = '', rows = 6) => E('textarea', {placeholder, value, rows});
function toast(message) { const t = $('#toast'); t.textContent = message; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => t.hidden = true, 6500); }
async function guarded(fn) { try { return await fn(); } catch (e) { toast(e.message || 'Something went wrong.'); } }
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Echo-CSRF': state.data.csrf}, body: JSON.stringify(body)});
  if (response.status === 401) { location.replace('/login'); throw new Error('Sign in required.'); }
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error || 'Request failed.');
  return value;
}
function modal(title, ...children) { $('#modal-body').replaceChildren(E('h2', {}, title), ...children); $('#modal').showModal(); }
function closeModal() { $('#modal').close(); }
function pre(value) { return E('pre', {class: 'result'}, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
function empty(title, detail) { return E('div', {class: 'empty'}, E('div', {class: 'orb'}, E('img', {src: '/echo-icon.png', alt: 'Echo emblem'})), E('h1', {}, title), E('p', {}, detail)); }
function section(title, detail, ...children) { return E('div', {class: 'page'}, E('div', {class: 'page-heading'}, E('h1', {}, title), E('p', {}, detail)), ...children); }
function card(title, detail, ...children) { return E('article', {class: 'card'}, E('h3', {}, title), E('p', {}, detail), ...children); }
async function refresh() { state.data = await api('/api/state'); sidebar(); }
function sidebar(chats = state.data.chats) {
  $('#chat-list').replaceChildren(...chats.slice(0, 50).map(c => B(c.title, () => openChat(c.id), 'chat-link' + (state.chat?.id === c.id ? ' active' : ''))));
  for (const button of document.querySelectorAll('nav button')) button.classList.toggle('selected', button.dataset.view === state.view);
  const s = state.data.sync;
  $('#journal-status').textContent = s.mode === 'private_local' ? 'Private journal & memories' : s.remaining ? `Journal saved · ${s.remaining} awaiting ECF` : 'Journal & ECF receipts';
}
function navigate(view) {
  window.echoVoice?.stopAll();
  if ($('#composer')) state.draft = $('#composer').value;
  state.view = view;
  sidebar();
  $('#sidebar').classList.remove('mobile-open');
  render();
}
async function newChat(project = state.project) { state.chat = await api('/api/chats', {project_id: project || null}); state.draft = ''; state.attachments.clear(); await refresh(); navigate('chats'); }
async function openChat(id) { state.chat = await api('/api/chats/' + encodeURIComponent(id)); state.draft = ''; state.attachments.clear(); navigate('chats'); }
function title(main, sub) { $('#page-title').textContent = main; $('#page-subtitle').textContent = sub; }
function projectSelect(value = '') {
  const select = E('select', {'aria-label': 'Project'}, E('option', {value: ''}, 'No project'), state.data.projects.map(p => E('option', {value: p.id}, p.name)));
  select.value = value || ''; return select;
}
function messageView(m) {
  const body = E('div', {class: 'message-text'});
  if (m.role === 'assistant') {
    const blocks = m.content.split(/```/);
    blocks.forEach((block, n) => {
      if (n % 2) {
        const newline = block.indexOf('\n');
        const language = newline < 0 ? '' : block.slice(0, newline).trim();
        const code = newline < 0 ? block : block.slice(newline + 1).replace(/\n$/, '');
        body.append(E('div', {class: 'code-block'}, E('div', {class: 'code-head'}, language || 'Code', B('Save file', () => saveFileDialog(code, language))), E('pre', {}, E('code', {}, code))));
      } else body.append(E('div', {class: 'prose'}, block));
    });
  } else body.textContent = m.content;
  return E('article', {class: 'message ' + m.role}, E('div', {class: 'message-role'}, m.role === 'user' ? 'YOU' : 'ECHO PRIME'), body,
    E('div', {class: 'message-actions'}, B('Copy', () => navigator.clipboard.writeText(m.content)), m.role === 'assistant' ? B('Save to library', () => saveFileDialog(m.content, 'md')) : null,
      m.role === 'assistant' && m.id && state.data.voice?.configured ? B('▶ Listen', () => window.echoVoice.speak(m)) : null));
}
function saveFileDialog(content = '', language = 'md') {
  const extensions = {python: 'py', javascript: 'js', typescript: 'ts', powershell: 'ps1', bash: 'sh', json: 'json', html: 'html', css: 'css'};
  const name = input('Filename', 'note.' + (extensions[language] || (/^[a-z]{1,6}$/.test(language) ? language : 'txt')));
  const text = area('File content', content, 14);
  modal('Save to your library', field('Filename', name), field('Content', text), E('p', {class: 'muted'}, 'The journal will record the saved file, its full path, and its contents.'),
    B('Save file', async () => { const item = await api('/api/library', {name: name.value, content: text.value, chat_id: state.chat?.id, project_id: state.chat?.project_id || state.project || null}); await refresh(); closeModal(); toast('Saved: ' + item.path); if (state.view === 'library') render(); }, 'primary'));
}
function contextMeter() {
  let usage;
  for (const event of (state.chat?.events || []).slice().reverse()) {
    if (event.kind === 'compacted') break;
    if (event.kind === 'model_usage') { try { usage = JSON.parse(event.content); } catch {} break; }
  }
  const draft = $('#composer')?.value || state.draft || '';
  const estimated = Math.ceil(((state.chat?.context_chars || 0) + (state.data.base_context_chars || 0) + draft.length) / 4);
  const used = usage ? usage.prompt_tokens + (usage.completion_tokens || 0) + Math.ceil(draft.length / 4) : estimated;
  const capacity = state.data.context_length, percent = Math.min(100, used / capacity * 100);
  return E('div', {class: 'context-meter', title: usage ? 'Last measured prompt includes instructions, memories, attached files and tool definitions. Draft estimate uses four characters per token; new retrieval is measured when sent.' : 'Estimate includes saved messages, workspace instructions and your draft. Retrieved memory and attachments are measured when sent.'},
    E('progress', {max: capacity, value: used, 'aria-label': 'Context window used'}),
    E('span', {}, `${used.toLocaleString()} / ${capacity.toLocaleString()} · ${percent.toFixed(1)}% · ${usage ? (draft ? 'last turn + draft estimate' : 'measured last turn') : 'estimate'}`));
}
function renderChat() {
  const c = state.chat;
  title(c?.title || 'A little space to think.', `Echo Prime · ${Math.round(state.data.context_length / 1024)}K context · Automatic memory`);
  const wrapper = E('div', {class: 'chat-layout'});
  if (c) {
    const select = projectSelect(c.project_id);
    const personality = E('select', {'aria-label': 'Personality'}, (state.data.personalities || []).map(p => E('option', {value: p.id}, p.name)));
    personality.value = [...(c.events || [])].reverse().find(e => e.kind === 'personality_selected')?.content || 'auto';
    personality.addEventListener('change', () => guarded(async () => { await api('/api/action', {action: 'personality_select', chat_id: c.id, profile: personality.value}); state.chat = await api('/api/chats/' + c.id); toast('Personality loaded.'); }));
    select.addEventListener('change', () => guarded(async () => { state.chat = await api('/api/chat/update', {chat_id: c.id, title: c.title, project_id: select.value || null}); await refresh(); }));
    wrapper.append(E('div', {class: 'chat-toolbar'}, select, personality,
      B('Rename', () => { const name = input('Chat title', c.title); modal('Rename chat', field('Title', name), B('Save', async () => { state.chat = await api('/api/chat/update', {chat_id: c.id, title: name.value, project_id: c.project_id}); closeModal(); await refresh(); render(); }, 'primary')); }),
      B('Compact', async () => { if (state.busy) return; state.busy = true; toast('Creating a checkpoint. Originals remain saved.'); try { state.chat = await api('/api/compact', {chat_id: c.id}); await refresh(); render(); } finally { state.busy = false; } }),
      B('Continue in new chat', async () => { if (state.busy) return; state.chat = await api('/api/fork', {chat_id: c.id}); await refresh(); render(); }),
      E('a', {href: '/api/journals/' + c.id, target: '_blank', rel: 'noopener', class: 'button-link'}, 'Journal ↗')));
    if (c.summary) wrapper.append(E('details', {class: 'checkpoint'}, E('summary', {}, 'Checkpoint active · original history preserved'), E('div', {class: 'prose'}, c.summary)));
  }
  const messages = E('div', {id: 'messages', class: 'messages', 'aria-live': 'polite'});
  if (!c?.messages.length) messages.append(empty('What are we working on?', 'A focused chat with your FORGE model. Keep a conversation going, bring in a project, or pick up an earlier idea.'),
    E('div', {class: 'starters'}, ['Plan something', 'Find an earlier decision', 'Review my code'].map((text, i) => B(text + ' ↗', () => { if (i === 2) navigate('review'); else { $('#composer').value = i === 0 ? 'Help me make a practical plan for ' : 'Find what we previously decided about '; $('#composer').focus(); } }))));
  else {
    const timeline = [...c.messages.map(m => ({created: m.created, render: () => messageView(m)})),
      ...(c.events || []).filter(e => ['tool_result', 'action_receipt', 'preference_saved'].includes(e.kind)).map(e => ({created: e.created, render: () => activityCard(e)}))];
    timeline.sort((a,b) => a.created.localeCompare(b.created));
    messages.append(...timeline.map(x => x.render()));
  }
  wrapper.append(messages);
  const compose = area('Message Echo…', state.draft, 2); compose.id = 'composer'; compose.maxLength = 100000;
  compose.addEventListener('input', () => { state.draft = compose.value; $('#context-meter')?.replaceChildren(contextMeter()); });
  compose.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); guarded(send); } });
  const mic = B('🎙', () => window.echoVoice?.dictate(), 'mic-button');
  mic.setAttribute('aria-label', 'Dictate message'); mic.title = 'Dictate into the message box';
  const voiceMode = B('◉ Voice', () => window.echoVoice?.toggleConversation(), 'quiet');
  voiceMode.setAttribute('data-voice-mode', ''); voiceMode.setAttribute('aria-pressed', String(window.echoVoice?.isConversation?.() || false));
  const sendButton = B('Send ↑', send, 'primary'); sendButton.id = 'send'; sendButton.disabled = state.busy;
  const attachments = E('div', {class: 'attachment-list'}, [...state.attachments].map(id => { const f = state.data.library.find(x => x.id === id); return B((f?.name || 'File') + ' ×', () => { state.draft = compose.value; state.attachments.delete(id); renderChatIntoPage(); }, 'chip'); }));
  wrapper.append(E('div', {class: 'composer-wrap'}, E('div', {class: 'composer'}, attachments, compose,
    E('div', {class: 'composer-actions'}, B('＋ Attach', attachmentDialog, 'quiet'), mic, voiceMode,
      E('span', {class: 'memory-chip', title: 'Relevant chat history, Crystal, ECF, Arcanum and Knowledge Forge are checked automatically.'}, '◈ Memory · automatic'), sendButton)),
    E('div', {class: 'composer-note'}, E('span', {id: 'chat-progress'}, state.busy ? 'Echo is working…' : 'Enter to send · Shift+Enter for a new line'), E('span', {id: 'context-meter'}, contextMeter()))));
  const voiceControls = window.echoVoice?.controls();
  if (voiceControls) wrapper.querySelector('.composer-wrap').append(voiceControls);
  return wrapper;
}
function renderChatIntoPage() { $('#content').replaceChildren(renderChat()); }
function attachmentDialog() {
  modal('Attach from your library', E('p', {class: 'muted'}, 'Selected file contents are included in your next message.'),
    ...state.data.library.slice(0, 100).map(f => { const checkbox = E('input', {type: 'checkbox', checked: state.attachments.has(f.id)}); checkbox.addEventListener('change', () => checkbox.checked ? state.attachments.add(f.id) : state.attachments.delete(f.id)); return E('label', {class: 'file-choice'}, checkbox, E('span', {}, f.name, E('small', {}, f.path))); }),
    B('Done', () => { state.draft = $('#composer')?.value || state.draft; closeModal(); renderChatIntoPage(); }, 'primary'));
}
async function send() {
  if (state.busy) return;
  window.echoVoice?.stopSpeech();
  const content = $('#composer').value.trim(); if (!content) return;
  if (!state.chat) { state.chat = await api('/api/chats', {project_id: state.project || null}); await refresh(); }
  state.busy = true; state.draft = ''; $('#composer').value = ''; $('#send').disabled = true;
  const chatId = state.chat.id;
  let spokenReply;
  $('#messages').append(messageView({role: 'user', content})); $('#messages').scrollTop = $('#messages').scrollHeight;
  $('#messages').append(E('details', {id: 'thinking', class: 'thinking'}, E('summary', {}, E('span', {class: 'thinking-spinner', 'aria-hidden': 'true'}), E('span', {id: 'thinking-text', role: 'status'}, 'Echo is thinking…'), E('small', {}, ' · View activity')), E('ol', {id: 'activity-steps'})));
  try {
    const response = await fetch('/api/chat', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Echo-CSRF': state.data.csrf}, body: JSON.stringify({chat_id: chatId, content, request_id: crypto.randomUUID(), attachments: [...state.attachments]})});
    if (!response.ok) throw new Error((await response.json()).error || 'Chat request failed.');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', done = false;
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, {stream: true});
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) if (line.trim()) {
        const event = JSON.parse(line);
        window.echoEsh?.receive(chatId, event);
        if (event.type === 'status' && $('#chat-progress')) $('#chat-progress').textContent = event.text;
        if (event.type === 'status' && $('#thinking-text')) $('#thinking-text').textContent = event.text;
        if (event.type === 'status') $('#activity-steps')?.append(E('li', {}, event.text));
        if (event.type === 'memory_saved') { toast('Preference saved for future chats.'); $('#activity-steps')?.append(E('li', {}, 'Saved your preference; ECF sync queued.')); }
        if (event.type === 'tool_started') {
          $('#thinking-text').textContent = 'Echo is working · ' + event.tool;
          $('#activity-steps')?.append(E('li', {}, E('details', {}, E('summary', {}, event.tool + ' · started'), pre(event.arguments))));
        }
        if (event.type === 'tool_result') {
          $('#activity-steps')?.append(E('li', {}, event.tool + (event.result?.ok === false ? ' · needs attention' : ' · result received')));
          $('#messages').insertBefore(activityCard({kind: 'tool_result', content: JSON.stringify(event)}), $('#thinking'));
          if (event.result?.ui_action) state.pendingUi = event.result.ui_action;
        }
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'done') { done = true; if (state.chat?.id === chatId) { state.chat = event.chat; spokenReply = event.chat.messages.filter(m => m.role === 'assistant').at(-1); } }
      }
    }
    if (!done) throw new Error('The connection closed before confirmation. Your journal may already contain the reply.');
    state.attachments.clear();
  } catch (e) {
    if (state.chat?.id === chatId) state.chat = await api('/api/chats/' + chatId);
    toast(e.message);
  } finally {
    state.busy = false; await refresh(); if (state.view === 'chats') { render(); $('#messages').scrollTop = $('#messages').scrollHeight; $('#composer').focus(); }
  }
  if (spokenReply && state.chat?.id === chatId && state.view === 'chats') await window.echoVoice?.afterReply(spokenReply, chatId);
  else window.echoVoice?.onChatError?.();
  if (state.pendingUi) { const action = state.pendingUi; state.pendingUi = null; if (action.action === 'open_chat') await openChat(action.id); else if (action.action === 'navigate') navigate(action.view); }
}
function activityCard(event) {
  let data; try { data = JSON.parse(event.content); } catch { data = {detail: event.content}; }
  const preference = event.kind === 'preference_saved';
  const label = preference ? 'Memory saved' : (data.tool || data.action || 'Plugin action');
  const result = data.result || data;
  const failed = result?.ok === false || result?.error;
  return E('details', {class: 'tool-card'}, E('summary', {}, E('span', {class: failed ? 'pending' : 'good'}, preference ? '◈ ' : '⌘ '), label, E('small', {}, failed ? ' · needs attention' : ' · recorded')),
    preference ? E('p', {}, data.content) : pre(result),
    E('small', {class: 'muted'}, preference ? 'Available in future chats. ECF delivery is tracked separately.' : 'Actual tool response. A submitted action is verified only when its receipt confirms the result.'));
}
function projectEditor(project) {
  const name = input('Project name', project?.name || ''), instructions = area('How should Echo work in this project?', project?.instructions || '', 8);
  modal(project ? 'Project instructions' : 'Create a project', field('Name', name), field('Instructions', instructions, 'Included in every chat assigned to this project.'),
    B(project ? 'Save project' : 'Create project', async () => { await api(project ? '/api/project/update' : '/api/projects', {id: project?.id, name: name.value, instructions: instructions.value}); closeModal(); await refresh(); render(); }, 'primary'));
}
function renderProjects() {
  title('Projects', 'Give related work a shared home.');
  return section('Everything for the same idea.', 'Group conversations and files, and give Echo instructions it can carry from chat to chat.', B('＋ New project', () => projectEditor(), 'primary'),
    E('div', {class: 'card-grid'}, state.data.projects.map(p => card(p.name, p.instructions || 'No project instructions yet.',
      E('span', {class: 'muted'}, state.data.chats.filter(c => c.project_id === p.id).length + ' chats'),
      E('div', {class: 'row'}, B('Start a chat', () => { state.project = p.id; return newChat(p.id); }), B('Instructions', () => projectEditor(p))),
      ...state.data.chats.filter(c => c.project_id === p.id).slice(0, 6).map(c => B(c.title, () => openChat(c.id), 'chat-link'))))));
}
function importDialog() {
  const source = E('select', {}, ['chatgpt', 'claude', 'grok', 'other'].map(x => E('option', {value: x}, x)));
  const name = input('Chat title'), data = area('Paste a normalized JSON chat or a transcript', '', 12);
  const file = E('input', {type: 'file', accept: '.json,.txt,.md'});
  file.addEventListener('change', () => guarded(async () => { const f = file.files[0]; if (f.size > 1900000) throw new Error('Choose an export under 1.9 MB.'); data.value = await f.text(); if (!name.value) name.value = f.name; }));
  modal('Import an earlier chat', E('p', {class: 'muted'}, 'Import a chat you choose. This does not connect to or monitor another provider’s account. Imported records are journaled and queued for ECF.'),
    field('Source', source), field('Title', name), field('File', file), field('Transcript or JSON', data),
    B('Import chat', async () => {
      let document;
      try { document = JSON.parse(data.value); } catch { document = {messages: [{role: 'user', content: data.value}]}; }
      // Accept a single official ChatGPT conversation or Claude export in addition to the documented neutral format.
      if (Array.isArray(document)) { if (document.length !== 1) throw new Error('Choose one exported conversation at a time.'); document = document[0]; }
      if (document.mapping) {
        const branch = []; let current = document.current_node; const seen = new Set();
        while (current && document.mapping[current] && !seen.has(current)) { seen.add(current); const node = document.mapping[current]; if (node.message) branch.push(node.message); current = node.parent; }
        document = {title: document.title, messages: branch.reverse().filter(m => ['user', 'assistant'].includes(m.author?.role) && m.content?.parts?.some(p => typeof p === 'string')).map(m => ({role: m.author.role, content: m.content.parts.filter(p => typeof p === 'string').join('\n'), timestamp: m.create_time ? new Date(m.create_time * 1000).toISOString() : undefined}))};
      } else if (document.chat_messages) document = {title: document.name, messages: document.chat_messages.map(m => ({role: m.sender === 'human' ? 'user' : 'assistant', content: m.text || (m.content || []).map(x => x.text || '').join('\n'), timestamp: m.created_at})).filter(m => m.content)};
      state.chat = await api('/api/import', {...document, source: source.value, title: name.value || document.title || 'Imported chat'}); closeModal(); await refresh(); navigate('chats');
    }, 'primary'));
}
function renderLibrary() {
  title('Library', 'Useful files, saved with their context.');
  const list = E('div', {class: 'library-list'});
  const search = input('Search names and paths', '', 'search');
  const draw = () => list.replaceChildren(...state.data.library.filter(f => (f.name + ' ' + f.path).toLowerCase().includes(search.value.toLowerCase())).map(f =>
    E('article', {class: 'file-row'}, E('span', {class: 'file-icon'}, '▤'), E('div', {}, E('strong', {}, f.name), E('small', {}, f.path)), B('Open', async () => { const item = await api('/api/library/' + f.id); modal(item.name, E('p', {class: 'muted'}, item.path), pre(item.content), B('Download', () => { const link = E('a', {href: URL.createObjectURL(new Blob([item.content], {type: 'text/plain'})), download: item.name}); link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); })); }), B('Attach', () => { state.attachments.add(f.id); navigate('chats'); }))));
  search.addEventListener('input', draw); draw();
  const upload = E('input', {type: 'file', accept: '.txt,.md,.py,.js,.ts,.tsx,.jsx,.json,.html,.css,.csv,.sql,.ps1,.sh,.diff,.patch', hidden: true});
  upload.addEventListener('change', () => guarded(async () => { const f = upload.files[0]; if (f.size > 100000) throw new Error('Choose a text file under 100 KB.'); if (/\.env|\.(pem|key|p12)$/i.test(f.name)) throw new Error('Credential files belong in the Vault.'); const content = await f.text(); await api('/api/library', {name: f.name, content, chat_id: state.chat?.id, project_id: state.project || null}); await refresh(); render(); }));
  return section('Keep what matters.', 'Notes, code, and outputs stay searchable. Every file saved from a chat is recorded in that chat’s journal.', E('div', {class: 'row'}, B('＋ Write a note', () => saveFileDialog(), 'primary'), B('Upload text file', () => upload.click()), B('Import a chat', importDialog), upload), search, list);
}
function syncDialog() {
  const s = state.data.sync;
  if (s.mode === 'private_local') {
    modal('Your private memories', E('p', {}, 'Chats, Markdown journals and saved memories persist in your account’s own storage. Echo checks your saved memories and previous chats automatically.'), E('p', {class:'muted'}, 'This account does not send or retrieve memories through the owner’s shared ECF or Crystal services.')); return;
  }
  modal('Journal & ECF delivery', E('p', {}, `Every new chat starts a Markdown journal. ${s.verified} records have exact ECF readback; ${s.remaining} are awaiting confirmation.`),
    E('p', {class: 'muted'}, 'Original messages stay on disk when a checkpoint is created. ECF retries while this app runs. A successful write is shown separately from verified retrieval.'),
    pre(s), B('Retry pending records', async () => { toast('Checking ECF delivery…'); await api('/api/sync', {}); await refresh(); closeModal(); syncDialog(); }, 'primary'));
}
function renderPlugins() {
  title('Plugins & memory', 'Your connections, tools and memories.');
  const mcp = renderMcpConnections();
  if (state.data.user && state.data.user.role !== 'owner') return section('Your MCP connections.', 'Connect tools to your own account. Your memories and connections stay separate from other users.',mcp);
  const statuses = E('div', {class: 'card-grid'}, card('Crystal memory', 'Read and save durable memories.'), card('Continuity Fabric', 'Recall the ledger and deliver journal records.'), card('ESH', 'Run actions through the installed shell policy.'));
  const result = E('div');
  const query = input('What would you like to recall?'), provider = E('select', {}, E('option', {value: 'ecf'}, 'ECF'), E('option', {value: 'crystal'}, 'Crystal'));
  const memory = area('A memory to save explicitly to Crystal', '', 4);
  const cmd = area('Enter an ESH command', '', 3);
  const output = value => result.replaceChildren(pre(value));
  return section('Connected to your Echo systems.', 'Read connection status, retrieve context, and run a deliberate action. Each action remains subject to the current role and ESH policy.', mcp,
    B('Check connections', async () => { toast('Checking Echo connections…'); const data = await api('/api/plugins'); statuses.replaceChildren(...Object.entries(data).map(([name, value]) => card(name.toUpperCase(), value.ok ? 'Live read succeeded' : value.error, E('span', {class: 'pill ' + (value.ok ? 'good' : 'pending')}, value.ok ? 'Readable' : 'Unavailable')))); }), statuses,
    E('div', {class: 'card-grid'}, card('Recall a memory', 'Results keep their original provenance.', field('Source', provider), field('Search', query), B('Search memories', async () => output(await api('/api/action', {action: 'memory_search', plugin: provider.value, query: query.value, chat_id: state.chat?.id})))),
      card('Store a memory', 'Crystal storage verifies exact readback before reporting success.', field('Memory', memory), B('Save to Crystal', async () => output(await api('/api/action', {action: 'crystal_save', content: memory.value, chat_id: state.chat?.id})))),
      card('ESH action', 'Echo uses ESH autonomously. Open the bottom ESH panel to see commands and receipts or run your own.', field('Command', cmd), B('Run through ESH', async () => output(await api('/api/action', {action: 'esh', command: cmd.value, request_id: crypto.randomUUID(), chat_id: state.chat?.id}))))),
    card('Automatic journal hooks', 'Chat start → create Markdown. Message → append journal and ECF queue. File saved → record content, path and hash. Compact → preserve originals and record checkpoint. ECF delivery → retain receipt and verify retrieval.', B('View delivery status', syncDialog)),
    state.data.voice?.configured ? card('Personality Forge', 'M Freeman is resolved through the saved freeman persona. ElevenLabs supplies speech and Scribe transcription. Dictation and playback controls are inside each chat.',
      B('View personality assets', async () => output(await api('/api/action', {action: 'personality_assets', chat_id: state.chat?.id})))) : null,
    card('BloodlinePrime profile', state.data.directive.loaded ? 'Verified owner profile loaded into every model conversation.' : state.data.directive.reason, pre(state.data.directive)), result);
}
function renderSdk() {
  title('Echo SDK', 'Discover a capability. Inspect its contract. Run it with the current role.');
  const query = input('Search capabilities, for example vault or files', '', 'search'), results = E('div', {class: 'sdk-results'}), output = E('div');
  const capability = input('echo.namespace.action'), command = input('Command'), options = area('JSON options', '{}', 6);
  async function search() { const data = await api('/api/catalog?q=' + encodeURIComponent(query.value)); results.replaceChildren(E('p', {class: 'muted'}, `${data.matches.toLocaleString()} matches · showing up to 100`), ...data.results.map(c => E('button', {class: 'sdk-result', onClick: () => { capability.value = c.id; command.value = c.id.split('.').pop(); }}, E('strong', {}, c.id), E('span', {}, c.description || ''), E('small', {}, `Scope: ${c.scope || c.required_scope || 'check live schema'} · tier ${c.tier ?? c.danger_tier ?? '?'}`)))); }
  query.addEventListener('keydown', e => { if (e.key === 'Enter') guarded(search); });
  return section('The SDK, within reach.', `Catalog snapshot: ${(state.data.catalog.count || 0).toLocaleString()} capabilities. ${state.data.catalog.coverage || ''} Live invocation uses the inherited SOL mission scope.`,
    E('div', {class: 'row'}, query, B('Search', search, 'primary')), results,
    card('Inspect or invoke', state.data.mission_present ? 'A mission is present. Each capability still enforces its own permissions.' : 'No SOL mission is attached to this app. Discovery works from the saved catalog; live SDK calls are blocked until an authorized launch.',
      field('Capability', capability), field('Command', command), field('Options', options), E('div', {class: 'row'},
        B('Read live schema', async () => output.replaceChildren(pre(await api('/api/action', {action: 'sdk_detail', capability: capability.value})))),
        B('Invoke capability', async () => { const data = JSON.parse(options.value); output.replaceChildren(pre(await api('/api/action', {action: 'sdk', capability: capability.value, command: command.value, options: data, chat_id: state.chat?.id}))); }, 'primary'))), output);
}
function renderVault() {
  title('Vault', 'Credentials stay separate from conversations.');
  const service = input('Exact service name'), username = input('Account or username'), secret = input('Credential value', '', 'password'); secret.autocomplete = 'new-password';
  const output = E('div');
  async function run(operation) {
    const payload = {action: 'vault', operation, service: service.value, username: username.value, chat_id: state.chat?.id};
    if (operation === 'put') payload.secret = secret.value;
    try { output.replaceChildren(pre(await api('/api/action', payload))); } finally { secret.value = ''; delete payload.secret; }
  }
  return section('Use credentials without putting them in chat.', 'Store a credential through the scoped Vault hook, or retrieve its reference and metadata. Echo’s supported service connectors resolve the value on the server.',
    E('div', {class: 'callout'}, state.data.mission_present ? 'The current role must have the Vault permissions required by each action.' : 'Access pending: this process has no SOL mission. The connected SDK role also reported missing vault.read. Hook availability does not grant permission.'),
    card('Credential reference', 'Exact service and account names avoid ambiguous matches.', field('Service', service), field('Account', username), E('div', {class: 'row'}, B('Locate reference', () => run('locate')), B('Retrieve through Vault', () => run('get')), B('List metadata', () => run('list')))),
    card('Store or update', 'Only this isolated field carries the credential value. It is excluded from prompts, journals, the library and ECF records.', field('Credential', secret), B('Store in Vault', () => run('put'), 'primary')), output);
}
function renderReview() {
  title('Code review', 'Specific findings, grounded in the source you provide.');
  const name = input('File name', 'changes.diff'), source = area('Paste a diff or source file…', '', 16), project = projectSelect(state.project);
  const file = E('input', {type: 'file', accept: '.diff,.patch,.py,.js,.ts,.tsx,.jsx,.json,.html,.css,.ps1,.sh,.go,.rs,.cs,.cpp,.c,.java'});
  file.addEventListener('change', () => guarded(async () => { const f = file.files[0]; if (f.size > 40000) throw new Error('Review one file or diff under 40 KB.'); source.value = await f.text(); name.value = f.name; }));
  const button = B('Review with FORGE', async () => { button.disabled = true; button.textContent = 'Reviewing…'; try { state.chat = await api('/api/review', {name: name.value, content: source.value, project_id: project.value || null}); await refresh(); navigate('chats'); } finally { button.disabled = false; button.textContent = 'Review with FORGE'; } }, 'primary');
  return section('A second look at your code.', 'Findings include a severity, file and line, impact, and suggested fix. The supplied source and review report are saved together. A model review does not execute tests.',
    E('div', {class: 'card'}, E('div', {class: 'row'}, field('File name', name), field('Project', project)), field('Upload a text file', file), field('Code or diff', source), button));
}
function fleetHeader(fleet = state.data?.fleet) {
  let host = $('#fleet-header');
  if (!host) { host = E('div', {id: 'fleet-header', class: 'fleet-header', 'aria-label': 'Node connections'}); document.querySelector('main header').append(host); }
  const icons = {quench: '▣', forge: '⚙', anvil: '▤', hammer: '▰', temper: '◇', crucible: '⬡'};
  host.replaceChildren(...(fleet?.nodes || []).map(n => {
    const button = B('', () => modal(n.id.toUpperCase(), E('p', {class: 'muted'}, `${n.connection} · ${n.evidence || 'Awaiting live probe'}`), pre(n)), 'fleet-node ' + n.connection);
    button.append(E('span', {class: 'node-icon', 'aria-hidden': 'true'}, icons[n.id] || '▣'), E('span', {class: 'fleet-led', 'aria-hidden': 'true'}), n.id.toUpperCase());
    button.title = `${n.id.toUpperCase()}: ${n.connection} · ${n.role || 'role pending'}`;
    button.setAttribute('aria-label', button.title); return button;
  }));
}
function renderDiagnostics() {
  title('Diagnostics', 'Real operation receipts and connection checks.');
  const output = E('div', {}, E('p', {}, 'Loading diagnostics…'));
  const load = async () => { const d = await api('/api/diagnostics'); output.replaceChildren(card('Mission & memory sync', 'Readback status is separate from a submitted write.', pre({mission: d.mission, sync: d.sync})), card('Recent operations', 'Metadata only. Credential values and message bodies are excluded.', pre(d.operations))); };
  guarded(load);
  return section('Logs & debugging', 'C3PO, R2D2 and GS343 can use these receipts to diagnose failures. Repair claims require verification.', B('Refresh', load), output);
}
function render() { const views = {chats: renderChat, projects: renderProjects, library: renderLibrary, plugins: renderPlugins, sdk: renderSdk, vault: renderVault, review: renderReview, diagnostics: renderDiagnostics}; $('#content').replaceChildren(views[state.view]()); fleetHeader(); window.echoEsh?.sync(state.chat); }
window.echoEsh = window.EchoEshPanel.mount({
  host: $('#esh-dock'), api, getChat: () => state.chat,
  ensureChat: async () => { if (!state.chat) await newChat(); return state.chat.id; },
  onUpdated: async id => {
    const chat = await api('/api/chats/' + encodeURIComponent(id));
    if (state.chat?.id === id) {
      state.chat = chat;
      if (!state.busy && state.view === 'chats') { state.draft = $('#composer')?.value || state.draft; render(); }
    }
  }
});
window.echoLayout = window.EchoLayout.mount({root: $('#app'), sidebar: $('#sidebar'), host: $('#esh-dock'), esh: window.echoEsh});
const diagnosticsButton = E('button', {'data-view': 'diagnostics'}, '⌁ ', E('span', {}, 'Logs & debugging')); document.querySelector('nav').append(diagnosticsButton);
$('#new-chat').addEventListener('click', () => guarded(() => newChat()));
for (const button of document.querySelectorAll('nav button')) button.addEventListener('click', () => navigate(button.dataset.view));
$('#menu').addEventListener('click', () => $('#sidebar').classList.toggle('mobile-open'));
$('#journal-status').addEventListener('click', syncDialog);
$('#chat-search').addEventListener('input', () => { clearTimeout(sidebar.timer); sidebar.timer = setTimeout(() => guarded(async () => sidebar(await api('/api/chats?q=' + encodeURIComponent($('#chat-search').value)))), 250); });
guarded(async () => { await refresh(); render(); const health = await api('/api/health'); $('#connection').textContent = health.model.loaded ? 'FORGE · Model loaded' : 'FORGE · Connection needed'; $('#connection').classList.toggle('online', health.model.loaded); });
setInterval(() => guarded(async () => { if (!state.data || state.busy) return; const health = await api('/api/health'); state.data.sync = health.sync; $('#connection').textContent = health.model.loaded ? 'FORGE · Model loaded' : 'FORGE · Connection needed'; $('#connection').classList.toggle('online', health.model.loaded); sidebar(); }), 60000);
setInterval(() => { if (state.data) api('/api/fleet').then(fleet => { state.data.fleet = fleet; fleetHeader(fleet); }).catch(() => {}); }, 15000);
