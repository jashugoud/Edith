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
  gemini: { label: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  groq: { label: 'Groq (fast, free tier)', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' },
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
  wakeWord: false,
};

// ---------- pure helpers (unit-tested in Node) ----------

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

// --- wake word: "Edith" (speech recognition often hears it as edit / adith / idith) ---
const WAKE_RE = /\b(?:(?:hey|hi|hello|ok|okay)\s+)?(?:edith|edit|eadith|adith|idith|edeth|edis)\b[\s,.:;!?-]*/i;

function findWake(text) {
  const m = WAKE_RE.exec(String(text));
  if (!m) return null;
  return { command: String(text).slice(m.index + m[0].length).trim() };
}

// --- opening apps by voice ---
const APPS = {
  whatsapp: { name: 'WhatsApp', pkg: 'com.whatsapp', scheme: 'whatsapp', host: 'send', web: 'https://web.whatsapp.com' },
  youtube: { name: 'YouTube', pkg: 'com.google.android.youtube', host: 'www.youtube.com/', web: 'https://m.youtube.com' },
  instagram: { name: 'Instagram', pkg: 'com.instagram.android', host: 'www.instagram.com/', web: 'https://www.instagram.com' },
  snapchat: { name: 'Snapchat', pkg: 'com.snapchat.android', scheme: 'snapchat', host: '', web: 'https://www.snapchat.com' },
  gmail: { name: 'Gmail', pkg: 'com.google.android.gm', host: 'mail.google.com/', web: 'https://mail.google.com' },
  maps: { name: 'Google Maps', pkg: 'com.google.android.apps.maps', host: 'maps.google.com/', web: 'https://maps.google.com' },
  chrome: { name: 'Chrome', pkg: 'com.android.chrome', host: 'www.google.com/', web: 'https://www.google.com' },
  telegram: { name: 'Telegram', pkg: 'org.telegram.messenger', scheme: 'tg', host: '', web: 'https://web.telegram.org' },
  spotify: { name: 'Spotify', pkg: 'com.spotify.music', host: 'open.spotify.com/', web: 'https://open.spotify.com' },
  playstore: { name: 'Play Store', pkg: 'com.android.vending', host: 'play.google.com/store', web: 'https://play.google.com' },
  facebook: { name: 'Facebook', pkg: 'com.facebook.katana', host: 'www.facebook.com/', web: 'https://m.facebook.com' },
  twitter: { name: 'X', pkg: 'com.twitter.android', host: 'x.com/', web: 'https://x.com' },
  netflix: { name: 'Netflix', pkg: 'com.netflix.mediaclient', host: 'www.netflix.com/', web: 'https://www.netflix.com' },
  photos: { name: 'Google Photos', pkg: 'com.google.android.apps.photos', host: 'photos.google.com/', web: 'https://photos.google.com' },
  settings: { name: 'Settings', action: 'android.settings.SETTINGS', web: '' },
  phone: { name: 'Phone', action: 'android.intent.action.DIAL', web: '' },
  amazon: { name: 'Amazon', pkg: 'in.amazon.mShop.android.shopping', host: 'www.amazon.in/', web: 'https://www.amazon.in' },
};

const APP_ALIASES = {
  'whats app': 'whatsapp', watsapp: 'whatsapp', 'you tube': 'youtube', insta: 'instagram', snap: 'snapchat',
  'google maps': 'maps', map: 'maps', 'play store': 'playstore', 'google play': 'playstore',
  'google play store': 'playstore', mail: 'gmail', email: 'gmail', 'google chrome': 'chrome', browser: 'chrome',
  x: 'twitter', dialer: 'phone', 'google photos': 'photos', gallery: 'photos',
};

function parseAppCommand(text) {
  const t = String(text).trim().replace(/[.!?]+$/, '');
  let m = /^(?:please\s+)?(?:open|launch)\s+(?:the\s+)?(.+)$/i.exec(t);
  if (m) {
    const clean = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const full = clean(m[1]);
    const noApp = full.replace(/ app$/, '');
    for (const c of [full, noApp]) {
      const key = APP_ALIASES[c] || c.replace(/ /g, '');
      if (APPS[key]) return { type: 'app', key };
    }
    return { type: 'unknown', name: m[1].replace(/\s+app$/i, '') };
  }
  m = /^(?:please\s+)?play\s+(.+?)\s+on\s+you\s?tube$/i.exec(t);
  if (m) return { type: 'url', label: 'YouTube: ' + m[1], url: 'https://m.youtube.com/results?search_query=' + encodeURIComponent(m[1]) };
  m = /^(?:please\s+)?(?:search|google)\s+(?:for\s+)?(.+)$/i.exec(t);
  if (m) return { type: 'url', label: 'Search: ' + m[1], url: 'https://www.google.com/search?q=' + encodeURIComponent(m[1]) };
  return null;
}

function buildIntentUrl(app) {
  if (app.action) return 'intent:#Intent;action=' + app.action + ';end';
  const scheme = app.scheme || 'https';
  let u = 'intent://' + (app.host || '') + '#Intent;scheme=' + scheme + ';package=' + app.pkg + ';';
  if (app.web) u += 'S.browser_fallback_url=' + encodeURIComponent(app.web) + ';';
  return u + 'end';
}

if (typeof module !== 'undefined') {
  module.exports = { parseSSE, deltaFromEvent, cleanForSpeech, buildRequest, streamChat, findWake, parseAppCommand, buildIntentUrl, APPS, PRESETS, DEFAULT_SETTINGS };
}

// ---------- UI (browser only) ----------

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const els = {
    msgs: $('msgs'), input: $('input'), send: $('send'), orb: $('orb'), status: $('status'),
    settingsBtn: $('settingsBtn'), dlg: $('dlg'), toast: $('toast'), speakBtn: $('speakBtn'),
    clearBtn: $('clearBtn'), earBtn: $('earBtn'),
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
  let state = 'idle'; // idle | listening | thinking | speaking
  let handsFree = !!settings.wakeWord;
  let awaitingCommand = false;
  let directMode = false;
  let rec = null;
  let currentAudio = null;
  let cancelSpeakFn = null;
  let speakToken = 0;
  let wakeLock = null;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const saveSettings = () => { try { localStorage.setItem('edith.settings', JSON.stringify(settings)); } catch (e) {} };
  const saveHistory = () => { try { localStorage.setItem('edith.history', JSON.stringify(history.slice(-40))); } catch (e) {} };

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => els.toast.classList.remove('show'), 4500);
  }

  function statusText() {
    if (state === 'listening') return handsFree && !directMode && !awaitingCommand ? 'Say "Edith"…' : 'Listening…';
    if (state === 'thinking') return 'Thinking…';
    if (state === 'speaking') return 'Speaking. Tap E to stop';
    return handsFree ? 'Say "Edith" or tap E' : 'Tap E to talk';
  }
  function setState(s) {
    state = s;
    els.orb.dataset.state = s;
    els.status.textContent = statusText();
  }
  function updateEar() {
    els.earBtn.classList.toggle('on', handsFree);
    els.earBtn.setAttribute('aria-pressed', handsFree ? 'true' : 'false');
    els.status.textContent = statusText();
  }

  function addBubble(role, text) {
    const b = document.createElement('div');
    b.className = 'bubble ' + role;
    b.textContent = text;
    els.msgs.appendChild(b);
    els.msgs.scrollTop = els.msgs.scrollHeight;
    return b;
  }
  function addLinkBubble(text, href, label) {
    const b = addBubble('assistant', text);
    const a = document.createElement('a');
    a.className = 'applink';
    a.href = href;
    if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
    a.textContent = label;
    b.appendChild(document.createElement('br'));
    b.appendChild(a);
    els.msgs.scrollTop = els.msgs.scrollHeight;
  }

  function renderHistory() {
    els.msgs.textContent = '';
    if (!history.length) {
      addBubble('assistant', "Hi, I'm Edith, your personal assistant. Tap the E to talk to me, or turn on 👂 and just say \"Edith\". Open ⚙️ to connect me to an AI brain.");
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
    if (cancelSpeakFn) {
      const f = cancelSpeakFn;
      cancelSpeakFn = null;
      f();
    }
  }
  function playBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      currentAudio = a;
      a.onended = () => { URL.revokeObjectURL(url); resolve(); };
      a.onerror = () => resolve();
      a.play().catch(reject);
    });
  }
  function browserSpeak(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      const v = voices.find((x) => /female|samantha|zira|aria|jenny|google us english/i.test(x.name)) || voices.find((x) => x.lang && x.lang.startsWith('en'));
      if (v) u.voice = v;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
  async function playChosenVoice(t) {
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
    return browserSpeak(t);
  }
  async function speak(text) {
    const t = cleanForSpeech(text).slice(0, 1900);
    stopSpeaking();
    const my = ++speakToken;
    if (t && settings.voiceMode !== 'off') {
      setState('speaking');
      const cancelled = new Promise((r) => { cancelSpeakFn = r; });
      await Promise.race([playChosenVoice(t), cancelled]);
    }
    if (my === speakToken) afterSpeak();
  }
  function afterSpeak() {
    if (busy) return;
    setState('idle');
    if (awaitingCommand) startRec(true);
    else if (handsFree) startRec(false);
  }

  // ----- listening -----
  function startRec(direct) {
    if (!SR) { toast('Voice input is not supported in this browser. Try Chrome.'); return; }
    if (rec || document.hidden) return;
    directMode = !!direct;
    let finalText = '';
    rec = new SR();
    rec.lang = navigator.language || 'en-IN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      if (directMode) els.input.value = (finalText + interim).trim();
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        handsFree = false;
        awaitingCommand = false;
        settings.wakeWord = false;
        saveSettings();
        updateEar();
        toast('Please allow the microphone for this app in Chrome site settings.');
      } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
        toast('Mic: ' + ev.error);
      }
    };
    rec.onend = () => {
      rec = null;
      const text = finalText.trim();
      const wasDirect = directMode;
      if (!text && wasDirect) awaitingCommand = false;
      if (state === 'listening') setState('idle');
      els.input.value = '';
      if (text) onSpeech(text, wasDirect || awaitingCommand);
      if (!busy && state === 'idle' && !document.hidden) {
        if (awaitingCommand) setTimeout(() => startRec(true), 200);
        else if (handsFree) setTimeout(() => startRec(false), 400);
      }
    };
    try {
      rec.start();
      setState('listening');
    } catch (e) {
      rec = null;
    }
  }

  function onSpeech(text, direct) {
    if (direct) {
      awaitingCommand = false;
      return handleCommand(text);
    }
    const w = findWake(text);
    if (!w) return; // ignore background chatter
    if (w.command) return handleCommand(w.command);
    awaitingCommand = true;
    speak('Yes?');
  }

  function handleCommand(text) {
    const cmd = parseAppCommand(text);
    if (!cmd) return send(text);
    addBubble('user', text);
    if (cmd.type === 'app') {
      const app = APPS[cmd.key];
      const href = buildIntentUrl(app);
      addLinkBubble('Opening ' + app.name + '.', href, 'Tap to open ' + app.name);
      speak('Opening ' + app.name);
      try { window.location.href = href; } catch (e) {}
    } else if (cmd.type === 'url') {
      addLinkBubble(cmd.label, cmd.url, 'Tap to open');
      speak('Here you go');
    } else {
      const names = Object.values(APPS).map((a) => a.name).join(', ');
      addBubble('assistant', "I can't open " + cmd.name + ' yet. I can open: ' + names + '.');
      speak("I can't open that app yet.");
    }
  }

  // ----- chat -----
  function setBusy(b) {
    busy = b;
    els.send.textContent = b ? 'Stop' : 'Send';
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    setBusy(true);
    stopSpeaking();
    if (rec) { try { rec.abort(); } catch (e) {} }
    els.input.value = '';
    history.push({ role: 'user', content: text });
    addBubble('user', text);
    const bubble = addBubble('assistant', '…');
    setState('thinking');
    abort = new AbortController();
    try {
      const full = await streamChat(settings, history, (t) => {
        bubble.textContent = t;
        els.msgs.scrollTop = els.msgs.scrollHeight;
      }, abort.signal);
      if (!full) throw new Error('The brain sent an empty reply.');
      history.push({ role: 'assistant', content: full });
      saveHistory();
      setBusy(false);
      speak(full);
    } catch (e) {
      if (e.name === 'AbortError') {
        bubble.textContent = bubble.textContent === '…' ? '(stopped)' : bubble.textContent;
      } else {
        bubble.textContent = 'Sorry, I could not reach my brain. ' + e.message;
        bubble.classList.add('error');
      }
      history.pop();
    } finally {
      abort = null;
      if (busy) setBusy(false);
      if (state === 'thinking') afterSpeak();
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
    history = [];
    saveHistory();
    renderHistory();
    toast('Chat cleared');
  };
  els.speakBtn.onclick = () => {
    settings.voiceMode = settings.voiceMode === 'off' ? 'browser' : 'off';
    saveSettings();
    stopSpeaking();
    els.speakBtn.textContent = settings.voiceMode === 'off' ? '🔇' : '🔊';
    toast(settings.voiceMode === 'off' ? 'Voice off' : 'Voice on');
  };

  // The big E
  els.orb.onclick = () => {
    if (state === 'speaking') { stopSpeaking(); return; }
    if (busy) { if (abort) abort.abort(); return; }
    if (rec) {
      directMode = true; // switch a wake-word listen into a direct listen
      try { rec.stop(); } catch (e) {}
      setState('listening');
      return;
    }
    startRec(true);
  };

  // "Say Edith" mode
  async function requestWake() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  function releaseWake() {
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
  els.earBtn.onclick = () => {
    handsFree = !handsFree;
    settings.wakeWord = handsFree;
    saveSettings();
    updateEar();
    if (handsFree) {
      requestWake();
      startRec(false);
      toast('Say "Edith" any time while this screen is open and on.');
    } else {
      releaseWake();
      awaitingCommand = false;
      if (rec) { try { rec.abort(); } catch (e) {} }
      setState('idle');
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rec) { try { rec.abort(); } catch (e) {} }
    } else if (handsFree) {
      requestWake();
      if (state === 'idle') startRec(false);
    }
  });

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
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
      const reply = await streamChat(s, [{ role: 'user', content: 'Reply with just the word: ready' }], () => {}, ac.signal);
      out.textContent = '✓ Connected. Brain said: ' + reply.slice(0, 80);
    } catch (e) {
      out.textContent = e.name === 'AbortError' ? '✗ No answer after 25 seconds. The brain may be busy. Try again.' : '✗ ' + e.message;
    } finally {
      clearTimeout(timer);
    }
  };
  els.settingsBtn.onclick = () => {
    fillSettings();
    f('testResult').textContent = '';
    els.dlg.showModal();
  };

  els.speakBtn.textContent = settings.voiceMode === 'off' ? '🔇' : '🔊';
  renderHistory();
  updateEar();
  setState('idle');
  if (handsFree) { requestWake(); startRec(false); }
  if (!settings.apiKey && settings.preset !== 'ollama' && settings.preset !== 'custom') {
    toast('Open Settings to add your brain key');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
