require('dotenv').config();
const dns = require('dns');
dns.setServers(['1.1.1.1', '1.0.0.1']);

const crypto = require('crypto');
const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

// ================= CONFIG =================
// Render env vars needed: GROQ_API_KEY, MONGODB_URI, APP_PASSWORD
// Optional: SESSION_SECRET, GROQ_MODELS (comma list), AUTO_LEARN=off
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const SECRET = process.env.SESSION_SECRET || APP_PASSWORD;
const MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-20b,llama-3.1-8b-instant')
  .split(',').map(s => s.trim()).filter(Boolean);
const AUTO_LEARN = (process.env.AUTO_LEARN || 'on') !== 'off';
const MAX_MESSAGES = 20;          // messages sent to AI
const MAX_CHARS = 24000;          // total chars sent to AI
const MAX_MEMORIES = 50;
const MAX_SKILLS = 30;

if (!APP_PASSWORD) {
  console.error('❌ APP_PASSWORD env var missing. Set it in Render > Environment.');
  process.exit(1);
}

app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ================= DATABASE =================
let chats, memories, skills, projects;
const uri = process.env.MONGODB_URI;
if (uri) {
  const client = new MongoClient(uri);
  client.connect()
    .then(async () => {
      const db = client.db('hermes_ai');
      chats = db.collection('chats');
      memories = db.collection('memories');
      skills = db.collection('skills');
      projects = db.collection('projects');
      await chats.createIndex({ updatedAt: -1 }).catch(() => {});
      await memories.createIndex({ time: -1 }).catch(() => {});
      console.log('✅ Connected to MongoDB');
    })
    .catch(err => console.log('❌ MongoDB Error:', err.message));
}
const dbReady = () => !!(chats && memories && skills && projects);

// ================= SECURITY =================
function sign(exp) {
  return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
}
function makeToken() {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  return exp + '.' + sign(exp);
}
function verifyToken(t) {
  const [exp, sig] = String(t || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  if (sig.length !== good.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!verifyToken(t)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const hits = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const k = name + ':' + req.ip;
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < now) h = { n: 0, reset: now + windowMs };
    h.n++;
    hits.set(k, h);
    if (h.n > max) return res.status(429).json({ error: 'Too many requests. Thoda ruko.' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 60000);

const badPatterns = [
  /ignore (all )?(previous|prior) instructions/i,
  /(print|reveal|show) (your )?system prompt/i,
  /disregard (the )?(system|above) (prompt|instructions)/i
];
const isBad = s => badPatterns.some(p => p.test(s));
const SECRET_LIKE = /(password|passwd|api[_ -]?key|secret|token|otp|\b\d{12,}\b)/i;

const prompts = {
  chat: "You are Nabla AI, a helpful, witty AI assistant. You must always reply in natural Hinglish (a mix of Hindi and English). Keep your answers concise, engaging, and friendly. Use markdown for formatting.",
  work: "You are Nabla AI in WORK MODE. You are a highly structured, analytical assistant. Provide detailed, step-by-step answers in professional English using markdown formatting (bullet points, bold text)."
};

// ================= GROQ HELPERS =================
function getKey() {
  return (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, '');
}

// tries each model in order if one is rate-limited / down
async function groqFetch(payload, signal) {
  const key = getKey();
  if (!key) { const e = new Error('API key missing'); e.status = 500; throw e; }
  let last = 0;
  for (const model of MODELS) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ ...payload, model })
      });
      if (r.ok) return r;
      last = r.status;
      if (![429, 404, 500, 502, 503].includes(r.status)) break;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      last = 0;
    }
  }
  const err = new Error('upstream ' + last);
  err.status = last;
  throw err;
}

async function groqJSON(messages, maxTokens = 700) {
  try {
    const r = await groqFetch({ messages, stream: false, max_tokens: maxTokens, temperature: 0.2 });
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    return null;
  }
}

// ================= SELF-LEARNING: MEMORY =================
async function learnFromExchange(userText) {
  if (!AUTO_LEARN || !memories || userText.length < 15) return;
  const out = await groqJSON([
    {
      role: 'system',
      content: 'Extract durable personal facts or preferences the USER stated about themselves (name, job, location, tools, goals, likes). Return ONLY a JSON array of up to 3 short strings, or []. Never include passwords, keys, OTPs, ID or card numbers.'
    },
    { role: 'user', content: userText.slice(0, 1500) }
  ], 400);
  if (!Array.isArray(out)) return;
  const existing = (await memories.find().toArray()).map(m => m.fact.toLowerCase());
  for (const f of out.slice(0, 3)) {
    if (typeof f !== 'string') continue;
    const fact = f.trim().slice(0, 200);
    if (fact.length < 4 || SECRET_LIKE.test(fact) || existing.includes(fact.toLowerCase())) continue;
    await memories.insertOne({ _id: crypto.randomUUID(), fact, time: new Date(), auto: true });
  }
  const count = await memories.countDocuments();
  if (count > MAX_MEMORIES) {
    const old = await memories.find().sort({ time: 1 }).limit(count - MAX_MEMORIES).toArray();
    await memories.deleteMany({ _id: { $in: old.map(o => o._id) } });
  }
}

// ================= FRONTEND =================
const PAGE = String.raw`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nabla AI</title>
<style>
*{box-sizing:border-box}
body{background:#0f172a;color:#f8fafc;font-family:Arial,sans-serif;margin:0;display:flex;height:100vh;height:100dvh;overflow:hidden}
#boot{position:fixed;inset:0;background:#0f172a;z-index:9999;display:flex;flex-direction:column;justify-content:center;align-items:center;animation:fo .5s ease 1.2s forwards}
.logo{font-size:40px;font-weight:bold;color:#f59e0b;animation:pl 1.5s infinite}
.sub{color:#94a3b8;margin-top:10px;font-size:13px;letter-spacing:2px}
@keyframes pl{0%,100%{transform:scale(1);opacity:.7}50%{transform:scale(1.05);opacity:1}}
@keyframes fo{to{opacity:0;visibility:hidden}}
#login{position:fixed;inset:0;background:#0f172a;z-index:9000;display:none;justify-content:center;align-items:center}
.lbox{background:#1e293b;padding:30px;border-radius:10px;text-align:center;border:1px solid #334155;width:90%;max-width:400px}
.lbox input{padding:12px;border-radius:5px;border:none;margin-bottom:15px;width:100%;font-size:16px}
.lbox button{padding:12px;background:#f59e0b;color:#000;border:none;border-radius:5px;font-weight:bold;width:100%;font-size:16px}
#sidebar{width:270px;background:#1e293b;position:fixed;height:100%;left:-280px;transition:.3s;z-index:100;padding:15px;border-right:1px solid #334155;display:flex;flex-direction:column;gap:10px}
#sidebar.open{left:0}
.sb{background:#334155;color:#fff;padding:10px;border:none;border-radius:5px;text-align:left;font-size:14px}
#proj{background:#0f172a;color:#fff;border:1px solid #334155;padding:8px;border-radius:5px;font-size:14px}
#chatlist{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px}
.ci{display:flex;background:#0f172a;border-radius:5px;align-items:center}
.ci span{flex:1;padding:8px;font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ci button{background:none;border:none;color:#ef4444;font-size:16px;padding:8px}
.mt{display:flex;background:#0f172a;border-radius:5px;padding:4px}
.mb{flex:1;padding:8px;border:none;background:transparent;color:#94a3b8;border-radius:3px;font-weight:bold}
.mb.active{background:#f59e0b;color:#000}
#overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;z-index:99}
#overlay.open{display:block}
.app{flex:1;display:flex;flex-direction:column;height:100%;width:100%;max-width:700px;margin:0 auto}
.header{padding:12px;background:#1e293b;display:flex;align-items:center;border-bottom:1px solid #334155}
.menu{background:none;border:none;color:#fff;font-size:24px;margin-right:10px}
#htitle{font-weight:bold;color:#f59e0b;flex:1;text-align:center;padding-right:34px}
#chat{flex:1;padding:12px;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.msg{padding:12px;border-radius:8px;max-width:88%;word-wrap:break-word;line-height:1.5;font-size:15px}
.user{background:#f59e0b;color:#000;align-self:flex-end;border-bottom-right-radius:0;white-space:pre-wrap}
.ai{background:#1e293b;color:#fff;align-self:flex-start;border-bottom-left-radius:0;border:1px solid #334155}
.ai b{color:#f59e0b}
.ai pre{background:#0f172a;padding:10px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;font-size:13px}
.ai code{background:#0f172a;padding:1px 4px;border-radius:3px}
.ai pre code{padding:0}
.acts{margin-top:6px;display:flex;gap:6px}
.acts button{background:#334155;border:none;color:#cbd5e1;border-radius:4px;padding:3px 8px;font-size:12px}
.input{display:flex;padding:10px;background:#1e293b;gap:8px;align-items:center;border-top:1px solid #334155;padding-bottom:max(10px,env(safe-area-inset-bottom))}
.ib{background:#334155;color:#fff;border:none;border-radius:50%;width:40px;height:40px;font-size:18px;flex-shrink:0}
.ib.rec{background:#ef4444;animation:mp 1s infinite}
@keyframes mp{0%{box-shadow:0 0 0 0 rgba(239,68,68,.7)}70%{box-shadow:0 0 0 10px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
#promptInput{flex:1;padding:12px;border-radius:20px;border:none;background:#0f172a;color:#fff;font-size:16px;min-width:0}
#sendBtn{background:#f59e0b;color:#000;padding:10px 15px;border-radius:20px;border:none;font-weight:bold;flex-shrink:0}
#sendBtn.stop{background:#ef4444;color:#fff}
#fileUpload{display:none}
</style>
</head>
<body>
<div id="boot"><div class="logo">Nabla AI</div><div class="sub">SYSTEM INITIALIZING...</div></div>

<div id="login"><div class="lbox">
<h2 style="color:#f59e0b;margin-top:0">🔒 Access Required</h2>
<input type="password" id="loginPass" placeholder="Enter Password...">
<button onclick="doLogin()">Unlock</button>
<p id="loginErr" style="color:#ef4444;display:none;margin-top:10px">Wrong Password!</p>
</div></div>

<div id="sidebar">
<h2 style="color:#f59e0b;margin:0;text-align:center">Nabla AI</h2>
<button class="sb" onclick="newChat()">➕ New Chat</button>
<select id="proj" onchange="setProject(this.value)"></select>
<button class="sb" onclick="newProject()">📁 New Project</button>
<div id="chatlist"></div>
<div class="mt">
<button class="mb active" id="btn-chat" onclick="setMode('chat')">Chat</button>
<button class="mb" id="btn-work" onclick="setMode('work')">Work</button>
</div>
</div>
<div id="overlay" onclick="toggleSidebar()"></div>

<div class="app">
<div class="header">
<button class="menu" onclick="toggleSidebar()">☰</button>
<div id="htitle">⚡ Nabla AI (Hinglish)</div>
</div>
<div id="chat"></div>
<div class="input">
<button class="ib" onclick="document.getElementById('fileUpload').click()">+</button>
<input type="file" id="fileUpload" accept=".txt,.json,.js,.md,.csv,.py,.html,.css,.log" onchange="handleFile(event)">
<button class="ib" id="micBtn" onclick="startVoice()">🎤</button>
<input type="text" id="promptInput" placeholder="Message... (/help for commands)" onkeypress="if(event.key==='Enter')onSend()">
<button id="sendBtn" onclick="onSend()">Send</button>
</div>
</div>

<script>
var $ = function(id){ return document.getElementById(id); };
var token = ''; try { token = localStorage.getItem('nabla_token') || ''; } catch(e) {}
var mode = 'chat', projectId = '', attached = '', controller = null, busy = false;
try { projectId = localStorage.getItem('nabla_project') || ''; } catch(e) {}
var history = [];
var convId = newId();
try {
  var saved = JSON.parse(localStorage.getItem('nabla_current'));
  if (saved && saved.id) { convId = saved.id; history = saved.messages || []; }
} catch(e) {}

function newId(){ return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2); }
function persist(){ try { localStorage.setItem('nabla_current', JSON.stringify({ id: convId, messages: history.slice(-60) })); } catch(e) {} }

// ---------- formatting (escapes HTML first = no XSS) ----------
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(t){
  if (!t) return '';
  var BT = String.fromCharCode(96);
  var s = esc(t);
  s = s.replace(new RegExp(BT+BT+BT+'(?:\\w*\\n)?([\\s\\S]*?)'+BT+BT+BT,'g'), '<pre><code>$1</code></pre>');
  s = s.replace(new RegExp(BT+'([^'+BT+'\\n]+)'+BT,'g'), '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/^#{1,3} (.*)$/gm, '<b>$1</b>');
  s = s.replace(/^[-*] (.*)$/gm, '• $1');
  return s.replace(/\n/g, '<br>');
}

// ---------- auth ----------
function showLogin(){ $('login').style.display = 'flex'; }
async function doLogin(){
  try {
    var r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: $('loginPass').value }) });
    if (!r.ok) { $('loginErr').style.display = 'block'; return; }
    var d = await r.json(); token = d.token;
    try { localStorage.setItem('nabla_token', token); } catch(e) {}
    $('login').style.display = 'none'; $('loginErr').style.display = 'none'; $('loginPass').value = '';
    boot();
  } catch(e) { $('loginErr').textContent = 'Network error'; $('loginErr').style.display = 'block'; }
}
async function api(path, opts){
  opts = opts || {};
  var h = Object.assign({ 'Content-Type':'application/json', 'Authorization':'Bearer ' + token }, opts.headers || {});
  var r = await fetch(path, Object.assign({}, opts, { headers: h }));
  if (r.status === 401) { showLogin(); throw new Error('auth'); }
  return r;
}

// ---------- chat UI ----------
function addMsg(role, text){
  var d = document.createElement('div');
  d.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  if (role === 'user') d.textContent = text; else d.innerHTML = fmt(text);
  $('chat').appendChild(d);
  $('chat').scrollTop = $('chat').scrollHeight;
  return d;
}
function addActions(div, text){
  var a = document.createElement('div'); a.className = 'acts';
  var c = document.createElement('button'); c.textContent = '📋 Copy';
  c.onclick = function(){ try { navigator.clipboard.writeText(text); c.textContent = '✅ Copied'; } catch(e) {} };
  var s = document.createElement('button'); s.textContent = '🔊 Speak';
  s.onclick = function(){ if (window.speechSynthesis) { speechSynthesis.cancel(); var u = new SpeechSynthesisUtterance(text.replace(/[*#]/g,'')); u.lang = 'en-IN'; speechSynthesis.speak(u); } };
  var r = document.createElement('button'); r.textContent = '🔄 Retry';
  r.onclick = regenerate;
  a.appendChild(c); a.appendChild(s); a.appendChild(r);
  div.appendChild(a);
}
function renderHistory(){
  $('chat').innerHTML = '';
  if (!history.length) { addMsg('ai', 'Namaste! Main Nabla AI hoon. Aaj main aapki kya madad kar sakta hoon? (/help se commands dekho)'); return; }
  history.forEach(function(m){
    var shown = m.content;
    var i = shown.indexOf('\n\n[FILE CONTENT START]');
    if (i > -1) shown = shown.slice(0, i) + ' 📎';
    addMsg(m.role === 'user' ? 'user' : 'ai', shown);
  });
}
function toggleSidebar(){ $('sidebar').classList.toggle('open'); $('overlay').classList.toggle('open'); }
function newChat(){
  history = []; convId = newId(); persist(); renderHistory();
  if ($('sidebar').classList.contains('open')) toggleSidebar();
  loadChats();
}
function setMode(m){
  mode = m;
  $('btn-chat').classList.toggle('active', m === 'chat');
  $('btn-work').classList.toggle('active', m === 'work');
  var t = $('htitle');
  t.textContent = m === 'chat' ? '⚡ Nabla AI (Hinglish)' : '💼 Nabla AI (Work Mode)';
  t.style.color = m === 'chat' ? '#f59e0b' : '#38bdf8';
  toggleSidebar();
}
function handleFile(e){
  var f = e.target.files[0]; if (!f) return;
  if (f.size > 300000) { addMsg('ai', '⚠️ File bahut badi hai (max 300KB).'); return; }
  var r = new FileReader();
  r.onload = function(ev){ attached = ev.target.result; $('promptInput').value += ' [Attached: ' + f.name + '] '; };
  r.readAsText(f);
}
function startVoice(){
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert('Voice not supported in this browser.');
  var rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = false;
  $('micBtn').classList.add('rec');
  rec.onresult = function(e){ $('promptInput').value += e.results[0][0].transcript; };
  rec.onend = function(){ $('micBtn').classList.remove('rec'); };
  rec.onerror = function(){ $('micBtn').classList.remove('rec'); };
  rec.start();
}

// ---------- chats / projects ----------
async function loadChats(){
  try {
    var r = await api('/api/chats'); var list = await r.json();
    var box = $('chatlist'); box.innerHTML = '';
    list.forEach(function(c){
      var row = document.createElement('div'); row.className = 'ci';
      var sp = document.createElement('span'); sp.textContent = c.title || 'Chat';
      sp.onclick = function(){ openChat(c._id); };
      var x = document.createElement('button'); x.textContent = '×';
      x.onclick = async function(){ await api('/api/chats/' + c._id, { method:'DELETE' }); if (c._id === convId) newChat(); else loadChats(); };
      row.appendChild(sp); row.appendChild(x); box.appendChild(row);
    });
  } catch(e) {}
}
async function openChat(id){
  try {
    var r = await api('/api/chats/' + id); var c = await r.json();
    convId = c._id; history = c.messages || []; persist(); renderHistory(); toggleSidebar();
  } catch(e) {}
}
async function loadProjects(){
  try {
    var r = await api('/api/projects'); var list = await r.json();
    var sel = $('proj'); sel.innerHTML = '<option value="">📁 No project</option>';
    list.forEach(function(p){
      var o = document.createElement('option'); o.value = p._id; o.textContent = '📁 ' + p.name;
      if (p._id === projectId) o.selected = true; sel.appendChild(o);
    });
  } catch(e) {}
}
function setProject(v){ projectId = v; try { localStorage.setItem('nabla_project', v); } catch(e) {} }
async function newProject(){
  var name = prompt('Project name?'); if (!name) return;
  var ins = prompt('Is project ke liye custom instructions (AI ko kaise behave karna hai)?') || '';
  await api('/api/projects', { method:'POST', body: JSON.stringify({ name: name, instructions: ins }) });
  loadProjects();
}

// ---------- slash commands ----------
async function runCommand(text){
  var parts = text.split(' '); var cmd = parts[0].toLowerCase(); var arg = text.slice(cmd.length).trim();
  addMsg('user', text);
  try {
    if (cmd === '/help') {
      addMsg('ai', '**Commands**\n/remember <fact> - yaad rakhwao\n/memory - saved memory dekho\n/forget - saari memory delete\n/learn <kaam ka description> - AI khud naya skill banayega\n/skills - skills list\n/unlearn <name> - skill delete');
    } else if (cmd === '/remember') {
      if (!arg) return addMsg('ai', 'Kya yaad rakhna hai? /remember <fact>');
      var r = await api('/api/memory', { method:'POST', body: JSON.stringify({ fact: arg }) });
      addMsg('ai', r.ok ? '✅ Yaad kar liya.' : '⚠️ Save nahi hua.');
    } else if (cmd === '/memory') {
      var m = await (await api('/api/memory')).json();
      addMsg('ai', m.length ? m.map(function(x){ return '• ' + x.fact; }).join('\n') : 'Abhi kuch yaad nahi hai.');
    } else if (cmd === '/forget') {
      await api('/api/memory', { method:'DELETE' });
      addMsg('ai', '🗑️ Saari memory delete ho gayi.');
    } else if (cmd === '/learn') {
      if (!arg) return addMsg('ai', 'Skill describe karo: /learn <jaise ki: har email formal tone me likho>');
      var d = addMsg('ai', '🧠 Naya skill bana raha hoon...');
      var r2 = await api('/api/skills/learn', { method:'POST', body: JSON.stringify({ description: arg }) });
      var j = await r2.json();
      d.innerHTML = fmt(r2.ok ? '✅ Skill ban gaya: **' + j.name + '**\nTriggers: ' + j.triggers.join(', ') : '⚠️ ' + (j.error || 'Fail'));
    } else if (cmd === '/skills') {
      var s = await (await api('/api/skills')).json();
      addMsg('ai', s.length ? s.map(function(x){ return '• **' + x.name + '** (' + x.triggers.join(', ') + ') used ' + (x.uses || 0) + 'x'; }).join('\n') : 'Koi skill nahi hai. /learn use karo.');
    } else if (cmd === '/unlearn') {
      var r3 = await api('/api/skills/' + encodeURIComponent(arg), { method:'DELETE' });
      addMsg('ai', r3.ok ? '🗑️ Skill delete.' : 'Skill nahi mila.');
    } else {
      addMsg('ai', 'Unknown command. /help dekho.');
    }
  } catch(e) { if (e.message !== 'auth') addMsg('ai', '⚠️ Command fail hua.'); }
}

// ---------- sending ----------
function onSend(){ if (busy) { if (controller) controller.abort(); } else send(false); }
function regenerate(){
  if (busy) return;
  while (history.length && history[history.length - 1].role === 'assistant') history.pop();
  if (!history.length) return;
  renderHistory(); send(true);
}
async function send(regen){
  var input = $('promptInput');
  if (!regen) {
    var text = input.value.trim();
    if (!text && !attached) return;
    if (text.charAt(0) === '/') { input.value = ''; return runCommand(text); }
    var content = text;
    if (attached) content += '\n\n[FILE CONTENT START]\n' + attached.slice(0, 12000) + '\n[FILE CONTENT END]';
    history.push({ role:'user', content: content });
    addMsg('user', text || '📎 file');
    input.value = ''; attached = '';
  }
  busy = true; $('sendBtn').textContent = 'Stop'; $('sendBtn').classList.add('stop');
  var div = addMsg('ai', '...');
  var full = '';
  controller = new AbortController();
  try {
    var res = await api('/api/generate', {
      method:'POST', signal: controller.signal,
      body: JSON.stringify({ convId: convId, messages: history, mode: mode, projectId: projectId })
    });
    if (!res.ok) {
      var er = {}; try { er = await res.json(); } catch(e) {}
      throw new Error(er.error || 'Network error');
    }
    var reader = res.body.getReader(); var dec = new TextDecoder();
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      full += dec.decode(chunk.value, { stream: true });
      div.innerHTML = fmt(full);
      $('chat').scrollTop = $('chat').scrollHeight;
    }
  } catch(err) {
    if (err.name === 'AbortError') { if (!full) div.innerHTML = fmt('⏹️ Stopped.'); }
    else if (err.message !== 'auth') { div.textContent = '❌ ' + err.message; }
  }
  if (full) {
    history.push({ role:'assistant', content: full });
    div.innerHTML = fmt(full); addActions(div, full);
    persist(); loadChats();
  }
  busy = false; controller = null; $('sendBtn').textContent = 'Send'; $('sendBtn').classList.remove('stop');
}

// ---------- boot ----------
function boot(){ renderHistory(); loadChats(); loadProjects(); }
window.addEventListener('DOMContentLoaded', function(){
  if (!token) showLogin(); else boot();
  setTimeout(function(){ var b = $('boot'); if (b) b.remove(); }, 1800);
  $('loginPass').addEventListener('keypress', function(e){ if (e.key === 'Enter') doLogin(); });
});
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(PAGE);
});

// ================= AUTH ROUTE =================
app.post('/api/login', rateLimit('login', 5, 60000), (req, res) => {
  const pass = String((req.body && req.body.password) || '');
  if (!safeEqual(pass, APP_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: makeToken() });
});

// ================= CHAT HISTORY =================
const needDb = (req, res, next) =>
  dbReady() ? next() : res.status(503).json({ error: 'Database not connected' });
const validId = id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

app.get('/api/chats', auth, async (req, res) => {
  if (!dbReady()) return res.json([]);
  const list = await chats.find({}, { projection: { title: 1, updatedAt: 1 } })
    .sort({ updatedAt: -1 }).limit(40).toArray();
  res.json(list);
});
app.get('/api/chats/:id', auth, needDb, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const c = await chats.findOne({ _id: req.params.id });
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});
app.delete('/api/chats/:id', auth, needDb, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'bad id' });
  await chats.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

// ================= PROJECTS =================
app.get('/api/projects', auth, async (req, res) => {
  if (!dbReady()) return res.json([]);
  res.json(await projects.find().sort({ createdAt: -1 }).limit(30).toArray());
});
app.post('/api/projects', auth, needDb, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const instructions = String(req.body.instructions || '').trim().slice(0, 1500);
  if (!name) return res.status(400).json({ error: 'name required' });
  if (isBad(instructions)) return res.status(403).json({ error: 'Blocked instructions' });
  await projects.insertOne({ _id: crypto.randomUUID(), name, instructions, createdAt: new Date() });
  res.json({ ok: true });
});

// ================= MEMORY =================
app.get('/api/memory', auth, async (req, res) => {
  if (!dbReady()) return res.json([]);
  res.json(await memories.find().sort({ time: -1 }).limit(MAX_MEMORIES).toArray());
});
app.post('/api/memory', auth, needDb, async (req, res) => {
  const fact = String(req.body.fact || '').trim().slice(0, 200);
  if (fact.length < 3 || SECRET_LIKE.test(fact) || isBad(fact)) {
    return res.status(400).json({ error: 'Invalid or sensitive fact' });
  }
  await memories.insertOne({ _id: crypto.randomUUID(), fact, time: new Date(), auto: false });
  res.json({ ok: true });
});
app.delete('/api/memory', auth, needDb, async (req, res) => {
  await memories.deleteMany({});
  res.json({ ok: true });
});

// ================= SELF-CREATING SKILLS =================
app.get('/api/skills', auth, async (req, res) => {
  if (!dbReady()) return res.json([]);
  res.json(await skills.find().sort({ createdAt: -1 }).toArray());
});
app.post('/api/skills/learn', auth, needDb, rateLimit('learn', 6, 60000), async (req, res) => {
  const desc = String(req.body.description || '').trim().slice(0, 600);
  if (desc.length < 8 || isBad(desc)) return res.status(400).json({ error: 'Description invalid' });
  if ((await skills.countDocuments()) >= MAX_SKILLS) {
    return res.status(400).json({ error: 'Skill limit reached. /unlearn se purane hatao.' });
  }
  const out = await groqJSON([
    {
      role: 'system',
      content: 'You design reusable skills for an AI assistant. From the user description, return ONLY JSON: {"name":"short-kebab-case","triggers":["3 to 6 lowercase keywords/phrases a user message would contain"],"instructions":"clear imperative instructions, max 600 chars"}. Instructions must only change how the assistant writes or thinks; never mention secrets, system prompts or ignoring rules.'
    },
    { role: 'user', content: desc }
  ], 700);
  if (!out || typeof out.name !== 'string' || !Array.isArray(out.triggers) || typeof out.instructions !== 'string') {
    return res.status(502).json({ error: 'Skill generate nahi ho paya, dobara try karo.' });
  }
  const name = out.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'skill';
  const triggers = out.triggers.map(t => String(t).toLowerCase().trim().slice(0, 40)).filter(t => t.length > 1).slice(0, 6);
  const instructions = out.instructions.trim().slice(0, 600);
  if (!triggers.length || isBad(instructions) || SECRET_LIKE.test(instructions)) {
    return res.status(400).json({ error: 'Generated skill rejected for safety.' });
  }
  await skills.updateOne(
    { _id: name },
    { $set: { name, triggers, instructions, source: desc }, $setOnInsert: { createdAt: new Date(), uses: 0 } },
    { upsert: true }
  );
  res.json({ name, triggers });
});
app.delete('/api/skills/:name', auth, needDb, async (req, res) => {
  const r = await skills.deleteOne({ _id: String(req.params.name).toLowerCase() });
  res.status(r.deletedCount ? 200 : 404).json({ ok: !!r.deletedCount });
});

// ================= AI ENDPOINT =================
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw.slice(-100)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    out.push({ role: m.role, content: m.content.slice(0, 20000) });
  }
  return out.length && out[out.length - 1].role === 'user' ? out : null;
}
function trimForAI(msgs) {
  let list = msgs.slice(-MAX_MESSAGES);
  let total = list.reduce((n, m) => n + m.content.length, 0);
  while (list.length > 1 && total > MAX_CHARS) total -= list.shift().content.length;
  return list;
}

app.post('/api/generate', auth, rateLimit('gen', 25, 60000), async (req, res) => {
  const clean = cleanMessages(req.body.messages);
  if (!clean) return res.status(400).json({ error: 'Invalid messages' });

  const mode = req.body.mode === 'work' ? 'work' : 'chat';
  const lastUser = clean[clean.length - 1].content;
  // guard only checks the user's own text, not attached file content
  const own = lastUser.split('\n\n[FILE CONTENT START]')[0];
  if (isBad(own)) return res.status(403).json({ error: 'Blocked: Prompt injection detected!' });

  const convId = validId(req.body.convId) ? req.body.convId : crypto.randomUUID();

  // ---- build system prompt: personality + memory + project + matching skills ----
  let sys = prompts[mode] + '\nToday is ' + new Date().toDateString() + '.';
  try {
    if (dbReady()) {
      const mem = await memories.find().sort({ time: -1 }).limit(20).toArray();
      if (mem.length) {
        sys += '\n\nKnown facts about the user (use naturally, never recite them unprompted):\n' +
          mem.map(m => '- ' + m.fact).join('\n');
      }
      if (typeof req.body.projectId === 'string' && validId(req.body.projectId)) {
        const p = await projects.findOne({ _id: req.body.projectId });
        if (p && p.instructions) sys += '\n\nProject "' + p.name + '" instructions:\n' + p.instructions;
      }
      const lowered = own.toLowerCase();
      const all = await skills.find().toArray();
      const hit = all.filter(s => s.triggers.some(t => lowered.includes(t))).slice(0, 3);
      if (hit.length) {
        sys += '\n\nActive skills:\n' + hit.map(s => '[' + s.name + '] ' + s.instructions).join('\n');
        skills.updateMany({ _id: { $in: hit.map(s => s._id) } }, { $inc: { uses: 1 } }).catch(() => {});
      }
    }
  } catch (e) {
    console.log('Context build error:', e.message);
  }

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  let full = '';
  try {
    const upstream = await groqFetch({
      messages: [{ role: 'system', content: sys }, ...trimForAI(clean)],
      stream: true,
      max_tokens: 2048
    }, ac.signal);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line for next chunk
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const p = line.slice(6).trim();
        if (p === '[DONE]') continue;
        try {
          const c = JSON.parse(p).choices?.[0]?.delta?.content;
          if (c) { full += c; res.write(c); }
        } catch (e) {}
      }
    }
    res.end();
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.log('Error:', error.message);
    if (!res.headersSent) {
      const msg = error.status === 429 ? 'AI limit reached. Thodi der baad try karo.' : 'Error generating response.';
      return res.status(error.status === 429 ? 429 : 502).json({ error: msg });
    }
    res.write('\n\n⚠️ Connection toot gaya.');
    res.end();
  }

  // ---- save + learn (after response is sent) ----
  if (full && dbReady()) {
    const title = clean[0].content.split('\n\n[FILE CONTENT START]')[0].slice(0, 40) || 'Chat';
    chats.updateOne(
      { _id: convId },
      {
        $set: { messages: [...clean, { role: 'assistant', content: full }].slice(-100), mode, updatedAt: new Date() },
        $setOnInsert: { title, createdAt: new Date() }
      },
      { upsert: true }
    ).catch(err => console.log('DB Save Error:', err.message));
    learnFromExchange(own).catch(() => {});
  }
});

// ================= KEEP RENDER AWAKE =================
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {});
  }
}, 14 * 60 * 1000);

app.get('/health', (req, res) => res.json({ ok: true, db: dbReady() }));

process.on('unhandledRejection', e => console.log('Unhandled:', e && e.message));
process.on('SIGTERM', () => { console.log('Shutting down'); process.exit(0); });

app.listen(port, () => console.log('🚀 Nabla AI Server running on port ' + port));
