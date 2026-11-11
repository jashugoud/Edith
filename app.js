'use strict';

const DEFAULT_PROMPT =
  "You are Edith, the user's personal AI assistant. You are calm, polished, warm and supportive. " +
  'Be concise and clear and lead with the answer. Your replies may be spoken aloud, so use short ' +
  'sentences and avoid heavy formatting, long lists and raw URLs unless asked. ' +
  "If you don't know something, say so honestly.";

// type "anthropic" uses Claude's native API; "openai" works with any OpenAI-compatible server.
const PRESETS = {
  claude: { label: 'Claude (Anthropic)', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' },
  openai: { label: 'OpenAI (ChatGPT)', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  gemini: { label: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
  groq: { label: 'Groq (fast, free tier)', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openrouter: { label: 'OpenRouter (many models)', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  ollama: { label: 'Ollama on my PC', type: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  custom: { label: 'Custom / my own agent (OpenAI-compatible URL)', type: 'openai', baseUrl: '', model: '' },
};

const DEFAULT_SETTINGS = {
  preset: 'claude',
  baseUrl: PRESETS.claude.baseUrl,
  model: PRESETS.claude.model,
  apiKey: '',
  systemPrompt: DEFAULT_PROMPT,
  voiceMode: 'browser', // browser | cartesia | server | off
  cartesiaKey: '',
  cartesiaVoice: '',
  voiceServerUrl: '',
};

// ---------- pure helpers (unit-tested in Node) ----------

// Split a streaming buffer into complete SSE events (their data payloads) and the leftover.
function parseSSE(buffer) {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop();
  const events = [];
  for (const part of parts) {
    const data = part
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (data) events.push(data);
  }
  return { events, rest };
}

// Turn one SSE data payload into {text} | {done} | {error}, for either API style.
function deltaFromEvent(data) {
  if (data === '[DONE]') return { done: true };
  let j;
  try {
    j = JSON.parse(data);
  } catch (e) {
    return { text: '' };
  }
  if (j.type === 'error' || (j.error && !j.choices)) {
    const err = j.error || {};
    return { error: err.message || (typeof err === 'string' ? err : 'Provider error') };
  }
  if (j.type === 'content_block_delta') return { text: (j.delta && j.delta.text) || '' };
  if (j.type === 'message_stop') return { done: true };
  const d = j.choices && j.choices[0] && j.choices[0].delta;
  return { text: (d && d.content) || '' };
}

function cleanForSpeech(t) {
  return String(t)
    .replace(/```[\s\S]*?```/g, ' code omitted. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[*_#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build the fetch() arguments for the chosen provider.
function buildRequest(settings, history) {
  const preset = PRESETS[settings.preset] || PRESETS.custom;
  const base = (settings.baseUrl || '').replace(/\/+$/, '');
  const msgs = history.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-20);
  if (preset.type === 'anthropic') {
    return {
      url: base + '/messages',
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: settings.model,
          max_tokens: 1024,
          system: settings.systemPrompt,
          messages: msgs,
          stream: true,
        }),
      },
    };
  }
  const headers = { 'content-type': 'application/json' };
  if (settings.apiKey) headers.authorization = 'Bearer ' + settings.apiKey;
  return {
    url: base + '/chat/completions',
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: settings.model,
        stream: true,
        messages: [{ role: 'system', content: settings.systemPrompt }, ...msgs],
      }),
    },
  };
}

// Stream a reply; calls onText(fullSoFar) as it grows. Returns the final text.
async function streamChat(settings, history, onText, signal, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const { url, init } = buildRequest(settings, history);
  if (!settings.baseUrl) throw new Error('No brain connected yet. Open Settings and choose one.');
  if (!settings.model) throw new Error('Please set a model name in Settings.');
  const res = await doFetch(url, { ...init, signal });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (e) {}
    throw new Error('Brain returned ' + res.status + (detail ? ': ' + detail : ''));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSSE(buffer);
    buffer = parsed.rest;
    for (const ev of parsed.events) {
      const d = deltaFromEvent(ev);
      if (d.error) throw new Error(d.error);
      if (d.text) {
        full += d.text;
        onText(full);
      }
    }
  }
  return full;
}

if (typeof module !== 'undefined') {
  module.exports = { parseSSE, deltaFromEvent, cleanForSpeech, buildRequest, streamChat, PRESETS, DEFAULT_SETTINGS };
}

// ---------- UI (browser only) ----------

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const els = {
    msgs: $('msgs'), input: $('input'), send: $('send'), mic: $('mic'), settingsBtn: $('settingsBtn'),
    dlg: $('dlg'), toast: $('toast'), speakBtn: $('speakBtn'), clearBtn: $('clearBtn'),
  };

  let settings = { ...DEFAULT_SETTINGS };
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('edith.settings') || '{}') };
  } catch (e) {}
  let history = [];
  try {
    history = JSON.parse(localStorage.getItem('edith.history') || '[]');
  } catch (e) {}
  let abort = null;
  let busy = false;
  let currentAudio = null;

  const saveSettings = () => localStorage.setItem('edith.settings', JSON.stringify(settings));
  const saveHistory = () => localStorage.setItem('edith.history', JSON.stringify(history.slice(-40)));

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => els.toast.classList.remove('show'), 4000);
  }

  function addBubble(role, text) {
    const b = document.createElement('div');
    b.className = 'bubble ' + role;
    b.textContent = text;
    els.msgs.appendChild(b);
    els.msgs.scrollTop = els.msgs.scrollHeight;
    return b;
  }

  function renderHistory() {
    els.msgs.textContent = '';
    if (!history.length) {
      addBubble('assistant', "Hi, I'm Edith, your personal assistant. Open Settings to connect me to an AI brain, then say hello.");
    }
    history.forEach((m) => addBubble(m.role, m.content));
  }

  // ----- voice output -----
  function stopSpeaking() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
  }
  function playBlob(blob) {
    const url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);
    currentAudio.onended = () => URL.revokeObjectURL(url);
    return currentAudio.play();
  }
  function browserSpeak(text) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => /female|samantha|zira|aria|jenny|google us english/i.test(x.name)) || voices.find((x) => x.lang && x.lang.startsWith('en'));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
  async function speak(text) {
    const t = cleanForSpeech(text).slice(0, 1900);
    if (!t || settings.voiceMode === 'off') return;
    stopSpeaking();
    try {
      if (settings.voiceMode === 'cartesia') {
        if (!settings.cartesiaKey || !settings.cartesiaVoice) throw new Error('Add Cartesia key and voice ID in Settings');
        const r = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: { 'X-API-Key': settings.cartesiaKey, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model_id: 'sonic-2', transcript: t, voice: { mode: 'id', id: settings.cartesiaVoice },
            output_format: { container: 'wav', encoding: 'pcm_f32le', sample_rate: 44100 },
          }),
        });
        if (!r.ok) throw new Error('Cartesia returned ' + r.status);
        return await playBlob(await r.blob());
      }
      if (settings.voiceMode === 'server') {
        if (!settings.voiceServerUrl) throw new Error('Add the Edith voice server URL in Settings');
        const r = await fetch(settings.voiceServerUrl.replace(/\/+$/, '') + '/speak', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: t, preset: 'assistant' }),
        });
        if (!r.ok) throw new Error('Voice server returned ' + r.status);
        return await playBlob(await r.blob());
      }
    } catch (e) {
      toast('Using the phone voice instead: ' + e.message);
    }
    browserSpeak(t);
  }

  // ----- chat -----
  function setBusy(b) {
    busy = b;
    els.send.textContent = b ? 'Stop' : 'Send';
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    stopSpeaking();
    els.input.value = '';
    history.push({ role: 'user', content: text });
    addBubble('user', text);
    const bubble = addBubble('assistant', '…');
    setBusy(true);
    abort = new AbortController();
    try {
      const full = await streamChat(settings, history, (t) => {
        bubble.textContent = t;
        els.msgs.scrollTop = els.msgs.scrollHeight;
      }, abort.signal);
      if (!full) throw new Error('The brain sent an empty reply.');
      history.push({ role: 'assistant', content: full });
      saveHistory();
      speak(full);
    } catch (e) {
      if (e.name === 'AbortError') {
        bubble.textContent = bubble.textContent === '…' ? '(stopped)' : bubble.textContent;
        history.pop();
      } else {
        bubble.textContent = 'Sorry, I could not reach my brain. ' + e.message;
        bubble.classList.add('error');
        history.pop();
      }
    } finally {
      setBusy(false);
      abort = null;
    }
  }

  els.send.onclick = () => (busy ? abort && abort.abort() : send(els.input.value));
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(els.input.value);
    }
  });
  els.clearBtn.onclick = () => {
    if (confirm('Clear this conversation?')) {
      history = [];
      saveHistory();
      renderHistory();
    }
  };
  els.speakBtn.onclick = () => {
    settings.voiceMode = settings.voiceMode === 'off' ? 'browser' : 'off';
    saveSettings();
    stopSpeaking();
    els.speakBtn.textContent = settings.voiceMode === 'off' ? '🔇' : '🔊';
    toast(settings.voiceMode === 'off' ? 'Voice off' : 'Voice on');
  };

  // ----- mic -----
  let rec = null;
  els.mic.onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('Voice input is not supported in this browser. Try Chrome.');
    if (rec) return rec.stop();
    stopSpeaking();
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.onresult = (ev) => {
      const r = ev.results[ev.results.length - 1];
      els.input.value = r[0].transcript;
      if (r.isFinal) send(els.input.value);
    };
    rec.onerror = (ev) => toast('Mic error: ' + ev.error);
    rec.onend = () => {
      rec = null;
      els.mic.classList.remove('on');
    };
    els.mic.classList.add('on');
    rec.start();
  };

  // ----- settings dialog -----
  const f = (id) => $(id);
  function fillSettings() {
    const sel = f('preset');
    if (!sel.options.length) {
      Object.entries(PRESETS).forEach(([k, p]) => sel.add(new Option(p.label, k)));
    }
    sel.value = settings.preset;
    f('baseUrl').value = settings.baseUrl;
    f('model').value = settings.model;
    f('apiKey').value = settings.apiKey;
    f('systemPrompt').value = settings.systemPrompt;
    f('voiceMode').value = settings.voiceMode;
    f('cartesiaKey').value = settings.cartesiaKey;
    f('cartesiaVoice').value = settings.cartesiaVoice;
    f('voiceServerUrl').value = settings.voiceServerUrl;
    toggleVoiceFields();
  }
  function toggleVoiceFields() {
    const m = f('voiceMode').value;
    f('cartesiaBox').hidden = m !== 'cartesia';
    f('serverBox').hidden = m !== 'server';
  }
  function readSettings() {
    return {
      ...settings,
      preset: f('preset').value,
      baseUrl: f('baseUrl').value.trim(),
      model: f('model').value.trim(),
      apiKey: f('apiKey').value.trim(),
      systemPrompt: f('systemPrompt').value.trim() || DEFAULT_PROMPT,
      voiceMode: f('voiceMode').value,
      cartesiaKey: f('cartesiaKey').value.trim(),
      cartesiaVoice: f('cartesiaVoice').value.trim(),
      voiceServerUrl: f('voiceServerUrl').value.trim(),
    };
  }
  f('preset').onchange = () => {
    const p = PRESETS[f('preset').value];
    f('baseUrl').value = p.baseUrl;
    f('model').value = p.model;
  };
  f('voiceMode').onchange = toggleVoiceFields;
  f('save').onclick = () => {
    settings = readSettings();
    saveSettings();
    els.speakBtn.textContent = settings.voiceMode === 'off' ? '🔇' : '🔊';
    els.dlg.close();
    toast('Saved');
  };
  f('cancel').onclick = () => els.dlg.close();
  f('test').onclick = async () => {
    const s = readSettings();
    const out = f('testResult');
    out.textContent = 'Testing…';
    try {
      const reply = await streamChat(s, [{ role: 'user', content: 'Reply with just the word: ready' }], () => {});
      out.textContent = '✓ Connected. Brain said: ' + reply.slice(0, 80);
    } catch (e) {
      out.textContent = '✗ ' + e.message;
    }
  };
  els.settingsBtn.onclick = () => {
    fillSettings();
    f('testResult').textContent = '';
    els.dlg.showModal();
  };

  els.speakBtn.textContent = settings.voiceMode === 'off' ? '🔇' : '🔊';
  renderHistory();
  if (!settings.apiKey && settings.preset !== 'ollama' && settings.preset !== 'custom') {
    toast('Open Settings to add your brain key');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
