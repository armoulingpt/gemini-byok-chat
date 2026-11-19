'use strict';
/* Gemini BYOK Chat — static, no backend.
   The API key lives only in localStorage in this browser and is sent
   only to Google's Generative Language API (as the `key` query parameter,
   which is how that API authenticates). It is never logged, never put in
   the page URL, and never written to any file or repo. */
const IMAGE_MODEL = 'gemini-2.5-flash-image';
const IMAGE_MODEL_PATH = 'models/gemini-2.5-flash-image';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const LS = {
  key: 'gemini_byok_key',
  model: 'gemini_byok_model',
  system: 'gemini_byok_system',
  temp: 'gemini_byok_temp',
  preset: 'gemini_byok_preset',
  theme: 'gemini_byok_theme',
  history: 'gemini_byok_history'
};
const PRESETS = {
  assistant: {
    system: 'You are a helpful, friendly assistant. Answer clearly and concisely, and use markdown when it helps.',
    temp: 0.7
  },
  coder: {
    system: 'You are an expert programmer. Give concise, working code first, then a brief explanation. Prefer modern, idiomatic code and note any assumptions.',
    temp: 0.3
  },
  'image-editor': {
    system: 'You are an image specialist. Keep image prompts and edit instructions short, concrete and visual: subject, style, lighting, composition. Avoid vague adjectives.',
    temp: 0.8
  }
};

const $ = (id) => document.getElementById(id);
const els = {
  apiKey: $('apiKey'), saveKey: $('saveKey'), forgetKey: $('forgetKey'),
  toggleKeyVisibility: $('toggleKeyVisibility'), keyMessage: $('keyMessage'),
  keyStatus: $('keyStatus'), modelSelect: $('modelSelect'),
  refreshModels: $('refreshModels'), modelMessage: $('modelMessage'),
  presetSelect: $('presetSelect'), systemPrompt: $('systemPrompt'),
  temperature: $('temperature'), temperatureValue: $('temperatureValue'),
  clearChat: $('clearChat'), exportChat: $('exportChat'),
  messages: $('messages'), composer: $('composer'), promptInput: $('promptInput'),
  sendBtn: $('sendBtn'), stopBtn: $('stopBtn'), attachBtn: $('attachBtn'),
  fileInput: $('fileInput'), attachPreview: $('attachPreview'),
  attachImg: $('attachImg'), attachName: $('attachName'), removeAttach: $('removeAttach'),
  modeHint: $('modeHint'), themeToggle: $('themeToggle')
};

let mode = 'chat';
let history = []; // {role:'user'|'model', text:string, images?:[{mimeType,data,url}]}
let attached = null; // {mimeType, data, url, name}
let aborter = null;
let codeStore = [];

function getKey() { return (localStorage.getItem(LS.key) || '').trim(); }
function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeUrl(u) {
  try {
    const parsed = new URL(u, 'https://example.invalid');
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:')
      ? escapeHtml(u) : null;
  } catch (e) { return null; }
}

/* ---- Minimal safe markdown: escape first, then format ---- */
function renderInline(escaped) {
  let out = escaped;
  out = out.replace(/`([^`\n]+)`/g, (m, c) => '<code>' + c + '</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const safe = safeUrl(url);
    return safe ? '<a href="' + safe + '" target="_blank" rel="noopener">' + label + '</a>' : label;
  });
  return out;
}
function renderMarkdown(raw) {
  codeStore = [];
  const text = String(raw || '');
  // Extract fenced code blocks first, keeping raw code for the copy button.
  const withoutCode = text.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
    const idx = codeStore.length;
    codeStore.push(code.replace(/\n$/, ''));
    const label = escapeHtml((lang || 'code').trim() || 'code');
    return '\u0000CODE' + idx + ':' + label + '\u0000';
  });
  const lines = withoutCode.split('\n');
  let html = '';
  let inList = null; // 'ul' | 'ol'
  const closeList = () => { if (inList) { html += '</' + inList + '>'; inList = null; } };
  for (const line of lines) {
    const codeMatch = line.match(/^\u0000CODE(\d+):([^\u0000]+)\u0000$/);
    if (codeMatch) {
      closeList();
      const idx = Number(codeMatch[1]);
      html += '<div class="code-head"><span>' + escapeHtml(codeMatch[2]) + '</span>'
        + '<button type="button" class="copy-btn" data-code-index="' + idx + '">Copy</button></div>'
        + '<pre><code>' + escapeHtml(codeStore[idx] || '') + '</code></pre>';
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) { closeList(); continue; }
    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html += '<h' + level + '>' + renderInline(escapeHtml(heading[2])) + '</h' + level + '>';
      continue;
    }
    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (inList !== tag) { closeList(); html += '<' + tag + '>'; inList = tag; }
      html += '<li>' + renderInline(escapeHtml(ul ? ul[1] : ol[1])) + '</li>';
      continue;
    }
    closeList();
    html += '<p>' + renderInline(escapeHtml(line)) + '</p>';
  }
  closeList();
  return html || '<p></p>';
}

function imageHtml(img, alt) {
  const src = escapeHtml(img.url || ('data:' + img.mimeType + ';base64,' + img.data));
  return '<img class="chat-image" src="' + src + '" alt="' + escapeHtml(alt || 'Generated image') + '">'
    + '<p><a href="' + src + '" download="gemini-image.png">Download image</a></p>';
}
function messageEl(role, text, images) {
  const div = document.createElement('div');
  div.className = 'message ' + (role === 'user' ? 'user' : 'assistant');
  const label = role === 'user' ? 'You' : 'Gemini';
  let inner = '<div class="role">' + label + '</div><div class="body">';
  if (text) inner += renderMarkdown(text);
  (images || []).forEach((img) => { inner += imageHtml(img, 'Image in conversation'); });
  inner += '</div>';
  div.innerHTML = inner;
  const codes = codeStore.slice(); // snapshot: renderMarkdown resets codeStore per message
  div.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = codes[Number(btn.getAttribute('data-code-index'))] || '';
      try { await navigator.clipboard.writeText(code); }
      catch (e) {
        const ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });
  return div;
}
function renderAll() {
  els.messages.innerHTML = '';
  if (!history.length) {
    els.messages.innerHTML = '<div class="empty-state"><div class="big">&#10022;</div>'
      + '<p><strong>Start a conversation</strong></p>'
      + '<p>Save your free Gemini key on the left, pick a model, then chat, generate an image, or edit one.</p></div>';
    return;
  }
  history.forEach((m) => els.messages.appendChild(messageEl(m.role, m.text, m.images)));
  els.messages.scrollTop = els.messages.scrollHeight;
}
function saveHistory() {
  try { localStorage.setItem(LS.history, JSON.stringify(history)); }
  catch (e) {
    try {
      const slim = history.map((m) => ({ role: m.role, text: m.text }));
      localStorage.setItem(LS.history, JSON.stringify(slim));
    } catch (e2) { /* history too large to persist; keep it in memory only */ }
  }
}
function loadHistory() {
  try {
    const raw = localStorage.getItem(LS.history);
    if (raw) history = JSON.parse(raw) || [];
  } catch (e) { history = []; }
  history = history.filter((m) => m && (m.text || (m.images && m.images.length)));
}
function pushMessage(role, text, images) {
  history.push({ role, text: text || '', images: images || undefined });
  saveHistory();
  renderAll();
}

/* ---- Settings ---- */
function updateKeyUI() {
  const has = !!getKey();
  els.keyStatus.textContent = has ? 'Key saved' : 'No key saved';
  els.keyStatus.classList.toggle('ok', has);
  els.refreshModels.disabled = !has;
  els.modelSelect.disabled = !has;
  if (!has) { els.modelSelect.innerHTML = '<option>Save a key first</option>'; }
}
function applyPreset(name, save) {
  const p = PRESETS[name];
  if (p) {
    els.systemPrompt.value = p.system;
    els.temperature.value = String(p.temp);
    els.temperatureValue.textContent = String(p.temp);
  }
  if (save) {
    localStorage.setItem(LS.preset, name);
    localStorage.setItem(LS.system, els.systemPrompt.value);
    localStorage.setItem(LS.temp, els.temperature.value);
  }
}
function setMode(next) {
  mode = next;
  ['Chat', 'Image', 'Edit'].forEach((m) => {
    const btn = $('mode' + m);
    const active = m.toLowerCase() === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  els.attachBtn.style.display = (next === 'image') ? 'none' : '';
  if (next === 'image') {
    els.modeHint.textContent = 'Describe an image. It will be made with gemini-2.5-flash-image (Nano Banana).';
    els.promptInput.placeholder = 'A watercolour fox in a misty forest, soft morning light\u2026';
    clearAttachment();
  } else if (next === 'edit') {
    els.modeHint.textContent = 'Attach an image, then tell Gemini how to change it \u2014 e.g. \u201cremove the background\u201d or \u201cmake it a watercolour\u201d.';
    els.promptInput.placeholder = 'Remove the background\u2026';
  } else {
    els.modeHint.textContent = 'Ask anything. Replies stream back as markdown.';
    els.promptInput.placeholder = 'Message Gemini\u2026';
  }
  els.promptInput.focus();
}
function setBusy(busy) {
  els.sendBtn.disabled = busy;
  els.stopBtn.classList.toggle('hidden', !busy);
}

/* ---- Gemini API ---- */
async function loadModels() {
  const key = getKey();
  if (!key) return;
  setMsg(els.modelMessage, 'Loading models\u2026');
  els.modelSelect.disabled = true;
  const found = [];
  try {
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const url = API_BASE + '/models?key=' + encodeURIComponent(key)
        + '&pageSize=100' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err.error && err.error.message) || ('HTTP ' + res.status));
      }
      const data = await res.json();
      (data.models || []).forEach((m) => {
        if ((m.supportedGenerationMethods || []).includes('generateContent')) found.push(m.name);
      });
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
  } catch (e) {
    setMsg(els.modelMessage, 'Could not load models: ' + e.message, 'error');
    els.modelSelect.disabled = false;
    return;
  }
  found.sort((a, b) => {
    const rank = (n) => (n.includes('2.5-flash') ? 0 : n.includes('flash') ? 1 : n.includes('pro') ? 2 : 3);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const saved = localStorage.getItem(LS.model) || '';
  els.modelSelect.innerHTML = '';
  found.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name.replace(/^models\//, '');
    els.modelSelect.appendChild(opt);
  });
  const preferred = found.includes(saved) ? saved
    : (found.find((n) => n === 'models/gemini-2.5-flash') || found[0] || '');
  if (preferred) els.modelSelect.value = preferred;
  els.modelSelect.disabled = false;
  setMsg(els.modelMessage, found.length ? 'Loaded ' + found.length + ' models.' : 'No generateContent models found for this key.', found.length ? 'ok' : 'error');
}
function apiContents() {
  return history.slice(-30).map((m) => {
    const parts = [];
    if (m.text) parts.push({ text: m.text });
    (m.images || []).forEach((img) => {
      if (img.data) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    });
    return { role: m.role === 'model' ? 'model' : 'user', parts: parts.length ? parts : [{ text: '' }] };
  }).filter((c) => c.parts.length);
}
function apiErrorMessage(status, data) {
  const msg = (data && data.error && data.error.message) || ('HTTP ' + status);
  return msg;
}
async function streamChat() {
  const key = getKey();
  const model = els.modelSelect.value;
  const system = els.systemPrompt.value.trim();
  const temp = parseFloat(els.temperature.value) || 0.7;
  const url = API_BASE + '/' + model + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(key);
  aborter = new AbortController();
  setBusy(true);
  // Add an empty assistant message we will fill as chunks arrive.
  history.push({ role: 'model', text: '' });
  renderAll();
  const bubble = els.messages.lastElementChild;
  const bodyEl = bubble ? bubble.querySelector('.body') : null;
  let fullText = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: apiContents().slice(0, -1),
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: { temperature: temp }
      }),
      signal: aborter.signal
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(apiErrorMessage(res.status, data));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop();
      for (const chunk of chunks) {
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let data;
          try { data = JSON.parse(payload); } catch (e) { continue; }
          const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
          parts.forEach((p) => { if (p.text) fullText += p.text; });
          if (bodyEl) { bodyEl.innerHTML = renderMarkdown(fullText); els.messages.scrollTop = els.messages.scrollHeight; }
        }
      }
    }
    if (!fullText.trim()) fullText = '(No text came back from the model.)';
  } catch (e) {
    if (e.name === 'AbortError') {
      fullText = fullText || '(Stopped.)';
    } else {
      fullText = 'Error: ' + e.message;
    }
  } finally {
    setBusy(false);
    aborter = null;
  }
  history[history.length - 1].text = fullText;
  saveHistory();
  renderAll();
}

function pollinationsUrl(prompt) {
  return 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt)
    + '?width=1024&height=1024&nologo=true';
}
function fallbackBox(prompt, status, message) {
  const div = document.createElement('div');
  div.className = 'fallback-box';
  div.innerHTML = '<p><strong>Gemini image generation is unavailable for this key right now</strong> ('
    + escapeHtml(String(status || '')) + ' ' + escapeHtml(message || '') + ').</p>'
    + '<p>Keyless fallback, clearly labelled: <strong>Pollinations</strong> (not Gemini). Image editing is not available from the fallback \u2014 it needs Gemini.</p>'
    + '<p><button type="button" class="btn primary" data-fallback="1">Try Pollinations instead</button></p>'
    + '<div class="fallback-result"></div>';
  div.querySelector('[data-fallback]').addEventListener('click', (ev) => {
    const url = pollinationsUrl(prompt);
    const target = div.querySelector('.fallback-result');
    target.innerHTML = '<img class="chat-image" src="' + escapeHtml(url) + '" alt="Pollinations image for: ' + escapeHtml(prompt) + '">'
      + '<p><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">Open / download the Pollinations image</a></p>'
      + '<p class="muted small">Generated by Pollinations, not Gemini.</p>';
    ev.currentTarget.disabled = true;
  });
  return div;
}
async function generateOrEditImage(prompt, sourceImage) {
  const key = getKey();
  const url = API_BASE + '/' + IMAGE_MODEL_PATH + ':generateContent?key=' + encodeURIComponent(key);
  const parts = [];
  if (sourceImage) parts.push({ inlineData: { mimeType: sourceImage.mimeType, data: sourceImage.data } });
  parts.push({ text: prompt });
  aborter = new AbortController();
  setBusy(true);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      }),
      signal: aborter.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(apiErrorMessage(res.status, data));
      err.status = res.status;
      throw err;
    }
    const candParts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const images = [];
    let text = '';
    candParts.forEach((p) => {
      if (p.inlineData && p.inlineData.data) {
        images.push({ mimeType: p.inlineData.mimeType || 'image/png', data: p.inlineData.data, url: 'data:' + (p.inlineData.mimeType || 'image/png') + ';base64,' + p.inlineData.data });
      } else if (p.text) { text += p.text; }
    });
    if (!images.length) {
      const note = text ? text + '\n\n' : '';
      pushMessage('model', note + '(Gemini replied with text only \u2014 no image came back. It may have refused the prompt.)', undefined);
      return;
    }
    pushMessage('model', text || (sourceImage ? 'Edited with ' + IMAGE_MODEL + '.' : 'Generated with ' + IMAGE_MODEL + '.'), images);
  } catch (e) {
    if (e.name === 'AbortError') { pushMessage('model', '(Stopped.)'); return; }
    const status = e.status || '';
    const isImageBlocked = status === 403 || status === 404 || status === 429;
    const note = 'Gemini image ' + (sourceImage ? 'editing' : 'generation') + ' failed: ' + e.message;
    if (sourceImage) {
      pushMessage('model', note + '\n\nImage editing requires Gemini \u2014 there is no keyless fallback for edits. Check the key, the model, and your quota in AI Studio.');
    } else if (isImageBlocked) {
      history.push({ role: 'model', text: note });
      saveHistory();
      renderAll();
      const last = els.messages.lastElementChild;
      if (last) last.querySelector('.body').appendChild(fallbackBox(prompt, status, e.message));
    } else {
      pushMessage('model', note);
    }
  } finally {
    setBusy(false);
    aborter = null;
  }
}

/* ---- Attachments ---- */
function clearAttachment() {
  attached = null;
  els.fileInput.value = '';
  els.attachPreview.classList.add('hidden');
}
function setAttachment(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result || '');
    const data = url.split(',')[1] || '';
    attached = { mimeType: file.type || 'image/png', data, url, name: file.name };
    els.attachImg.src = url;
    els.attachName.textContent = file.name;
    els.attachPreview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

/* ---- Events ---- */
els.saveKey.addEventListener('click', async () => {
  const key = els.apiKey.value.trim();
  if (!key) { setMsg(els.keyMessage, 'Paste your API key first.', 'error'); return; }
  localStorage.setItem(LS.key, key);
  els.apiKey.value = '';
  setMsg(els.keyMessage, 'Key saved in this browser only.', 'ok');
  updateKeyUI();
  await loadModels();
});
els.forgetKey.addEventListener('click', () => {
  localStorage.removeItem(LS.key);
  els.apiKey.value = '';
  setMsg(els.keyMessage, 'Key forgotten. Models cleared.', 'ok');
  updateKeyUI();
});
els.toggleKeyVisibility.addEventListener('click', () => {
  const show = els.apiKey.type === 'password';
  els.apiKey.type = show ? 'text' : 'password';
  els.toggleKeyVisibility.textContent = show ? 'Hide' : 'Show';
});
els.refreshModels.addEventListener('click', loadModels);
els.modelSelect.addEventListener('change', () => {
  localStorage.setItem(LS.model, els.modelSelect.value);
});
els.presetSelect.addEventListener('change', () => {
  const name = els.presetSelect.value;
  if (name === 'custom') { localStorage.setItem(LS.preset, 'custom'); return; }
  applyPreset(name, true);
});
els.systemPrompt.addEventListener('input', () => {
  els.presetSelect.value = 'custom';
  localStorage.setItem(LS.preset, 'custom');
  localStorage.setItem(LS.system, els.systemPrompt.value);
});
els.temperature.addEventListener('input', () => {
  els.temperatureValue.textContent = els.temperature.value;
  localStorage.setItem(LS.temp, els.temperature.value);
});
els.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(LS.theme, next);
});
els.clearChat.addEventListener('click', () => {
  if (aborter) aborter.abort();
  history = [];
  saveHistory();
  renderAll();
});
els.exportChat.addEventListener('click', () => {
  const md = history.map((m) => {
    const head = m.role === 'user' ? '## You' : '## Gemini';
    const imgs = (m.images || []).map(() => '[image]').join('\n');
    return head + '\n\n' + (m.text || '') + (imgs ? '\n\n' + imgs : '');
  }).join('\n\n---\n\n');
  const blob = new Blob([md || '# Gemini BYOK Chat\n\n(empty)\n'], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'gemini-chat.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
els.attachBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  if (file) setAttachment(file);
});
els.removeAttach.addEventListener('click', clearAttachment);
$('modeChat').addEventListener('click', () => setMode('chat'));
$('modeImage').addEventListener('click', () => setMode('image'));
$('modeEdit').addEventListener('click', () => setMode('edit'));
els.stopBtn.addEventListener('click', () => { if (aborter) aborter.abort(); });

els.composer.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const prompt = els.promptInput.value.trim();
  if (!prompt) return;
  if (!getKey()) {
    setMsg(els.keyMessage, 'Save your Gemini API key first (left panel).', 'error');
    els.apiKey.focus();
    return;
  }
  if (mode === 'chat') {
    if (!els.modelSelect.value) { setMsg(els.modelMessage, 'Load the model list first.', 'error'); return; }
    const images = attached ? [{ mimeType: attached.mimeType, data: attached.data, url: attached.url }] : undefined;
    pushMessage('user', prompt, images);
    els.promptInput.value = '';
    clearAttachment();
    await streamChat();
  } else if (mode === 'image') {
    pushMessage('user', prompt);
    els.promptInput.value = '';
    await generateOrEditImage(prompt, null);
  } else {
    if (!attached) {
      alert('Attach an image to edit first.');
      els.fileInput.click();
      return;
    }
    const img = { mimeType: attached.mimeType, data: attached.data, url: attached.url };
    pushMessage('user', prompt + '  (editing attached image)', [img]);
    els.promptInput.value = '';
    clearAttachment();
    await generateOrEditImage(prompt, img);
  }
});
els.promptInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    els.composer.requestSubmit();
  }
});

/* ---- Init ---- */
(function init() {
  const theme = localStorage.getItem(LS.theme);
  if (theme === 'dark' || (!theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  const preset = localStorage.getItem(LS.preset) || 'assistant';
  els.presetSelect.value = PRESETS[preset] ? preset : 'custom';
  if (PRESETS[preset]) applyPreset(preset, false);
  const savedSystem = localStorage.getItem(LS.system);
  if (savedSystem !== null) els.systemPrompt.value = savedSystem;
  const savedTemp = localStorage.getItem(LS.temp);
  if (savedTemp !== null) {
    els.temperature.value = savedTemp;
    els.temperatureValue.textContent = savedTemp;
  }
  loadHistory();
  renderAll();
  updateKeyUI();
  if (getKey()) loadModels();
  setMode('chat');
})();
