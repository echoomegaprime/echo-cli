'use strict';
// The microphone stays off until the user clicks Dictate and grants permission.
window.echoVoice = (() => {
  let player, capture, currentSpeech, currentSession, epoch = 0, message = 'M Freeman · ElevenLabs · Microphone off';
  let autoSpeak = localStorage.getItem('echo-spoken-replies') !== 'false';
  let brief = localStorage.getItem('echo-brief-speech') === 'true';
  let autoSend = localStorage.getItem('echo-send-speech') === 'true';
  let conversation = false, restartTimer;
  function modeState() {
    document.querySelectorAll('[data-voice-mode]').forEach(n => {
      n.setAttribute('aria-pressed', String(conversation)); n.textContent = conversation ? '◉ Voice on' : '◉ Voice';
    });
  }
  function resumeListening() {
    clearTimeout(restartTimer);
    if (conversation && !state.busy && state.view === 'chats') restartTimer = setTimeout(() => {
      if (conversation && !state.busy && !capture) guarded(dictate);
    }, 300);
  }
  async function toggleConversation() {
    if (conversation) { stopAll(); return; }
    if (state.busy) { toast('Wait for the current reply before starting Voice mode.'); return; }
    conversation = true; modeState(); await dictate();
  }
  const status = text => { message = text; document.querySelectorAll('[data-voice-status]').forEach(n => n.textContent = text); };
  async function call(operation, payload, signal) {
    const response = await fetch('/api/voice/' + operation, {method: 'POST', signal,
      headers: {'Content-Type': 'application/json', 'X-Echo-CSRF': state.data.csrf}, body: JSON.stringify(payload)});
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || 'Voice request failed.');
    return result;
  }
  function audioPlayer() {
    if (!player) {
      player = document.createElement('audio'); player.controls = true; player.id = 'voice-player'; player.hidden = true;
      player.setAttribute('aria-label', 'M Freeman spoken reply'); document.body.append(player);
    }
    return player;
  }
  function stopSpeech() {
    epoch++; currentSpeech?.abort(); currentSpeech = null;
    if (player) { player.pause(); player.hidden = true; player.removeAttribute('src'); player.load(); }
    if (currentSession) { call('cancel', currentSession).catch(() => {}); currentSession = null; }
    status(capture ? 'Listening…' : 'Ready · M Freeman · Microphone off');
  }
  function stopAll() {
    conversation = false; clearTimeout(restartTimer); modeState();
    stopSpeech();
    if (capture) capture.finish(true);
    status('Stopped · Microphone off');
  }
  function play(url, signal) {
    const audio = audioPlayer(); audio.src = url; audio.hidden = false;
    return new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Audio playback failed.')); };
      const cleanup = () => { audio.removeEventListener('ended', done); audio.removeEventListener('error', failed); signal.removeEventListener('abort', done); };
      audio.addEventListener('ended', done, {once: true}); audio.addEventListener('error', failed, {once: true}); signal.addEventListener('abort', done, {once: true});
      audio.play().catch(() => status('Press Play on the audio player to hear M Freeman.'));
    });
  }
  async function speak(reply, chatId = state.chat?.id) {
    if (!reply?.id || !chatId || !state.data.voice?.configured) return;
    stopSpeech();
    const version = epoch, controller = new AbortController(); currentSpeech = controller;
    status('Preparing M Freeman’s spoken reply…');
    try {
      let chunk = await call('start', {chat_id: chatId, message_id: reply.id, request_id: crypto.randomUUID(), mode: brief ? 'summary' : 'full'}, controller.signal);
      if (version !== epoch) return;
      currentSession = {session_id: chunk.session_id, chat_id: chatId};
      while (chunk && version === epoch) {
        status('Speaking · M Freeman · ElevenLabs');
        // At most one section is prepared ahead of playback.
        const next = chunk.has_more ? call('next', {...currentSession, chunk_index: chunk.chunk_index + 1}, controller.signal)
          .then(value => ({value}), error => ({error})) : null;
        await play(chunk.audio_url, controller.signal);
        if (version !== epoch) break;
        if (!next) break;
        const pending = await next;
        if (pending.error) throw pending.error;
        chunk = pending.value;
      }
      if (version === epoch) { status('Ready · M Freeman · Microphone off'); return true; }
    } catch (error) {
      if (error.name !== 'AbortError') { conversation = false; modeState(); status(error.message); toast(error.message); }
    } finally { if (version === epoch) { currentSpeech = null; currentSession = null; } }
  }
  function encodeWav(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
    const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767), true));
    let binary = ''; const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
  function resample(chunks, rate) {
    const size = chunks.reduce((n, part) => n + part.length, 0), input = new Float32Array(size);
    let offset = 0; for (const part of chunks) { input.set(part, offset); offset += part.length; }
    const output = new Float32Array(Math.floor(size * 16000 / rate)), ratio = rate / 16000;
    for (let i = 0; i < output.length; i++) {
      const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let total = 0; for (let j = start; j < end; j++) total += input[j];
      output[i] = total / Math.max(1, end - start);
    }
    return output;
  }
  async function dictate() {
    if (capture) { capture.finish(false); return; }
    if (state.busy) { toast('Wait for the current reply before dictating.'); return; }
    stopSpeech(); const version = epoch;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot capture a microphone here.');
    if (!state.chat) { state.chat = await api('/api/chats', {project_id: state.project || null}); await refresh(); render(); }
    const chatId = state.chat.id;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true}, video: false}); }
    catch { conversation = false; modeState(); status('Microphone permission is needed. Text chat remains available.'); return; }
    if (version !== epoch) { stream.getTracks().forEach(track => track.stop()); return; }
    const context = new AudioContext(), source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1), mute = context.createGain();
    mute.gain.value = 0; source.connect(processor); processor.connect(mute); mute.connect(context.destination); await context.resume();
    const chunks = [], started = performance.now(); let heard = false, lastSound = started, finished = false;
    const finish = async cancel => {
      if (finished) return; finished = true; capture = null;
      processor.onaudioprocess = null; source.disconnect(); processor.disconnect(); mute.disconnect(); stream.getTracks().forEach(track => track.stop()); await context.close();
      if (cancel || version !== epoch) return;
      if (!heard) { status('Waiting for speech…'); resumeListening(); return; }
      const samples = resample(chunks, context.sampleRate), parts = Math.ceil(samples.length / 120000), texts = [];
      const controller = new AbortController(); currentSpeech = controller;
      try {
        for (let i = 0; i < parts; i++) {
          if (version !== epoch || state.chat?.id !== chatId) return;
          status(`Transcribing ${i + 1} of ${parts} · Microphone off`);
          const transcript = await call('transcribe', {chat_id: chatId, request_id: crypto.randomUUID(), audio_b64: encodeWav(samples.subarray(i * 120000, (i + 1) * 120000))}, controller.signal);
          texts.push(transcript.text.trim());
        }
        if (version !== epoch || state.chat?.id !== chatId) return;
        const composer = $('#composer'); if (!composer) return;
        composer.value = [composer.value.trim(), ...texts].filter(Boolean).join(' '); state.draft = composer.value; composer.focus();
        status('Transcribed · Review your message or send it.');
        if (conversation || autoSend) await send();
      } catch (error) { if (error.name !== 'AbortError') { conversation = false; modeState(); status(error.message); toast(error.message); } }
      finally { if (version === epoch) currentSpeech = null; }
    };
    capture = {finish};
    processor.onaudioprocess = event => {
      const data = new Float32Array(event.inputBuffer.getChannelData(0)); chunks.push(data);
      const rms = Math.sqrt(data.reduce((total, value) => total + value * value, 0) / data.length), time = performance.now();
      if (rms > 0.012) { heard = true; lastSound = time; }
      if ((heard && time - lastSound >= 2000) || time - started >= 120000 || (!heard && time - started > 15000)) finish(false);
    };
    status('Listening · Pause for two seconds to finish · Click Dictate again to finish now');
  }
  function controls() {
    if (!state.data.voice?.configured) return null;
    const toggle = (label, checked, update) => {
      const box = E('input', {type: 'checkbox', checked}); box.addEventListener('change', () => update(box.checked));
      return E('label', {class: 'check'}, box, label);
    };
    return E('div', {class: 'voice-panel'}, E('div', {class: 'voice-controls'},
      B('Interrupt & speak', async () => { stopSpeech(); await dictate(); }, 'quiet'), B('Stop voice', stopAll, 'quiet'),
      toggle('Spoken replies', autoSpeak, value => { autoSpeak = value; localStorage.setItem('echo-spoken-replies', value); if (!value) stopSpeech(); }),
      toggle('Brief speech', brief, value => { brief = value; localStorage.setItem('echo-brief-speech', value); }),
      toggle('Send speech automatically', autoSend, value => { autoSend = value; localStorage.setItem('echo-send-speech', value); })),
      E('small', {'data-voice-status': '', role: 'status'}, message),
      E('small', {class: 'muted'}, 'Personality Forge · Your selected audio and spoken text use ElevenLabs.'));
  }
  window.addEventListener('beforeunload', stopAll);
  return {controls, speak, dictate, stopSpeech, stopAll, toggleConversation,
    isConversation: () => conversation,
    onChatError: () => { if (conversation) stopAll(); },
    afterReply: async (reply, chatId) => {
      if ((autoSpeak || conversation) && !capture) {
        const completed = await speak(reply, chatId);
        if (completed && conversation && state.chat?.id === chatId) resumeListening();
      }
    }};
})();
