require('dotenv').config();
const dns = require('dns');
dns.setServers(['1.1.1.1', '1.0.0.1']);

const crypto = require('crypto');
const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

// ===================================================================
//  NABLA JUGAAD (Hinglish AI) - self-creating, self-improving assistant
//  Render env: GROQ_API_KEY, MONGODB_URI, APP_PASSWORD
//  Optional : SESSION_SECRET, GROQ_MODELS, AUTO_LEARN=off,
//             AUTO_SKILL=off, REFLECT_EVERY=3
// ===================================================================
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const SECRET = process.env.SESSION_SECRET || APP_PASSWORD;
const MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-20b,llama-3.1-8b-instant')
  .split(',').map(s => s.trim()).filter(Boolean);
const AUTO_LEARN = (process.env.AUTO_LEARN || 'on') !== 'off';
const AUTO_SKILL = (process.env.AUTO_SKILL || 'on') !== 'off';
const REFLECT_EVERY = Math.max(1, parseInt(process.env.REFLECT_EVERY || '3', 10));
const MAX_MESSAGES = 20;
const MAX_CHARS = 24000;
const MAX_MEMORIES = 50;
const MAX_LESSONS = 15;
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
const needDb = (req, res, next) =>
  dbReady() ? next() : res.status(503).json({ error: 'Database not connected' });

// ================= SECURITY =================
function sign(exp) { return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex'); }
function makeToken() { const exp = Date.now() + 30 * 24 * 3600 * 1000; return exp + '.' + sign(exp); }
function verifyToken(t) {
  const [exp, sig] = String(t || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
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
    if (h.n > max) return res.status(429).json({ error: 'Bahut requests. Thoda ruko.' });
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
const FILE_MARK = '\n\n[FILE CONTENT START]';
const stripFile = s => String(s || '').split(FILE_MARK)[0];
const validId = id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

// small in-memory inbox: background learning events shown to the user
const notices = [];
function notify(text) { notices.push(text); if (notices.length > 10) notices.shift(); }

const prompts = {
  chat: "You are Nabla Jugaad, a helpful, witty AI assistant who finds smart practical solutions (jugaad). You must always reply in natural Hinglish (a mix of Hindi and English). Keep answers concise, engaging and friendly. Use markdown for formatting.",
  work: "You are Nabla Jugaad in WORK MODE. You are a highly structured, analytical assistant. Provide detailed, step-by-step answers in professional English using markdown formatting (bullet points, bold text)."
};

// ================= GROQ HELPERS =================
function getKey() { return (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, ''); }

async function groqFetch(payload, signal) {
  const key = getKey();
  if (!key) { const e = new Error('API key missing'); e.status = 500; throw e; }
  let last = 0;
  for (const model of MODELS) {
    try {
      const body = { ...payload, model };
      if (!model.includes('gpt-oss')) delete body.reasoning_effort;
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body)
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

// non-streaming call that must return JSON (used for background learning)
async function groqJSON(messages, maxTokens = 1200) {
  try {
    const r = await groqFetch({
      messages, stream: false, max_tokens: maxTokens, temperature: 0.2, reasoning_effort: 'low'
    });
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { return null; }
}

// ================= SELF-LEARNING 1: MEMORY =================
async function learnFromExchange(userText) {
  if (!AUTO_LEARN || !dbReady() || userText.length < 15) return;
  const out = await groqJSON([
    {
      role: 'system',
      content: 'Extract durable personal facts or preferences the USER stated about themselves (name, job, location, tools, goals, likes). Return ONLY a JSON array of up to 3 short strings, or []. Never include passwords, keys, OTPs, ID or card numbers.'
    },
    { role: 'user', content: userText.slice(0, 1500) }
  ], 600);
  if (!Array.isArray(out)) return;
  const existing = (await memories.find().toArray()).map(m => m.fact.toLowerCase());
  for (const f of out.slice(0, 3)) {
    if (typeof f !== 'string') continue;
    const fact = f.trim().slice(0, 200);
    if (fact.length < 4 || SECRET_LIKE.test(fact) || existing.includes(fact.toLowerCase())) continue;
    await memories.insertOne({ _id: crypto.randomUUID(), fact, type: 'fact', time: new Date(), auto: true });
    notify('💾 Yaad kar liya: ' + fact);
  }
  const facts = await memories.find({ type: { $ne: 'lesson' } }).sort({ time: 1 }).toArray();
  if (facts.length > MAX_MEMORIES) {
    const old = facts.slice(0, facts.length - MAX_MEMORIES);
    await memories.deleteMany({ _id: { $in: old.map(o => o._id) } });
  }
}

// ================= SELF-LEARNING 2: SKILLS =================
function normalizeSkill(out) {
  if (!out || typeof out.name !== 'string' || !Array.isArray(out.triggers) || typeof out.instructions !== 'string') return null;
  const name = out.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const triggers = [...new Set(out.triggers.map(t => String(t).toLowerCase().trim().slice(0, 40)).filter(t => t.length >= 3))].slice(0, 6);
  const instructions = out.instructions.trim().slice(0, 600);
  if (!name || !triggers.length || instructions.length < 10 || isBad(instructions) || SECRET_LIKE.test(instructions)) return null;
  return { name, triggers, instructions };
}

// Jugaad engine: Nabla notices a repeatable task style and creates a skill BY ITSELF
let reflectTick = 0;
async function reflectForSkill(userText) {
  const existing = await skills.find().toArray();
  if (existing.length >= MAX_SKILLS) return;
  const out = await groqJSON([
    {
      role: 'system',
      content: 'You help an AI assistant grow. Given a user request, decide if it shows a REUSABLE task type or style preference (for example: email writing, code review, summaries, study notes, a tone) that deserves a permanent skill. If not, return {"create":false}. Otherwise return ONLY JSON: {"create":true,"name":"short-kebab-case","triggers":["3 to 6 lowercase keywords or phrases future requests would contain"],"instructions":"clear imperative guidance, max 600 chars"}. Skills may only change how the assistant writes or thinks. Existing skills (do not duplicate): ' +
        JSON.stringify(existing.map(s => ({ name: s.name, triggers: s.triggers })))
    },
    { role: 'user', content: userText.slice(0, 800) }
  ]);
  if (!out || (out.create !== true && out.create !== 'true')) return;
  const sk = normalizeSkill(out);
  if (!sk) return;
  if (existing.some(s => s._id === sk.name || s.triggers.some(t => sk.triggers.includes(t)))) return;
  await skills.insertOne({
    _id: sk.name, ...sk, auto: true, uses: 0, score: 0, version: 1, disabled: false, createdAt: new Date()
  });
  notify('🧠 Maine khud naya skill seekha: ' + sk.name + ' (triggers: ' + sk.triggers.join(', ') + ')');
}

// Improve a skill using feedback; old version is kept so /rollback works
async function refineSkill(skill, request, badReply, note) {
  const out = await groqJSON([
    {
      role: 'system',
      content: 'You improve an AI assistant skill. You get the current skill instructions, a user request, an assistant reply the user disliked, and an optional user note. Rewrite the instructions so the next reply is better. Imperative style, max 600 chars, no secrets. Return ONLY JSON: {"instructions":"..."}'
    },
    {
      role: 'user',
      content: JSON.stringify({
        instructions: skill.instructions,
        request: String(request || '').slice(0, 600),
        bad_reply: String(badReply || '').slice(0, 1200),
        note: String(note || '').slice(0, 300)
      })
    }
  ]);
  if (!out || typeof out.instructions !== 'string') return false;
  const ins = out.instructions.trim().slice(0, 600);
  if (ins.length < 10 || isBad(ins) || SECRET_LIKE.test(ins)) return false;
  await skills.updateOne(
    { _id: skill._id },
    { $set: { instructions: ins, prev: skill.instructions, updatedAt: new Date() }, $inc: { version: 1 } }
  );
  return true;
}

// ================= FRONTEND =================
const PAGE = String.raw`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nabla Jugaad</title>
<style>
*{box-sizing:border-box}
body{background:#0f172a;color:#f8fafc;font-family:Arial,sans-serif;margin:0;display:flex;height:100vh;height:100dvh;overflow:hidden}
#boot{position:fixed;inset:0;background:#0f172a;z-index:9999;display:flex;flex-direction:column;justify-content:center;align-items:center;animation:fo .5s ease 1.2s forwards}
.logo{font-size:38px;font-weight:bold;color:#f59e0b;animation:pl 1.5s infinite}
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
.note{background:#0b3b2e;border-color:#115e45;font-size:13px}
.ai b{color:#f59e0b}
.ai pre{background:#0f172a;padding:10px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;font-size:13px}
.ai code{background:#0f172a;padding:1px 4px;border-radius:3px}
.ai pre code{padding:0}
.acts{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.acts button{background:#334155;border:none;color:#cbd5e1;border-radius:4px;padding:4px 8px;font-size:12px}
.acts button:disabled{opacity:.4}
.acts span{font-size:12px;color:#94a3b8;align-self:center}
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
<div id="boot"><div class="logo">Nabla Jugaad</div><div class="sub">SEEKH RAHA HOON...</div></div>

<div id="login"><div class="lbox">
<h2 style="color:#f59e0b;margin-top:0">🔒 Access Required</h2>
<input type="password" id="loginPass" placeholder="Enter Password...">
<button onclick="doLogin()">Unlock</button>
<p id="loginErr" style="color:#ef4444;display:none;margin-top:10px">Wrong Password!</p>
</div></div>

<div id="sidebar">
<h2 style="color:#f59e0b;margin:0;text-align:center">Nabla Jugaad</h2>
<button class="sb" onclick="newChat()">➕ New Chat</button>
<select id="proj" onchange="setProject(this.value)"></select>
<button class="sb" onclick="newProject()">📁 New Project</button>
<div id="chatlist"></div>
<div class="mt">
<button class="mb active" id="btn-chat" onclick="setMode('chat')">Chat</button>
<button class="mb" id="btn-work" onclick="setMode('work')">Work</button>
</div>
<div style="font-size:11px;color:#94a3b8;text-align:center">/help se commands dekho</div>
</div>
<div id="overlay" onclick="toggleSidebar()"></div>

<div class="app">
<div class="header">
<button class="menu" onclick="toggleSidebar()">☰</button>
<div id="htitle">⚡ Nabla Jugaad (Hinglish)</div>
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
    if (!r.ok) { $('loginErr').textContent = 'Wrong Password!'; $('loginErr').style.display = 'block'; return; }
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
function addMsg(role, text, extra){
  var d = document.createElement('div');
  d.className = 'msg ' + (role === 'user' ? 'user' : 'ai') + (extra ? ' ' + extra : '');
  if (role === 'user') d.textContent = text; else d.innerHTML = fmt(text);
  $('chat').appendChild(d);
  $('chat').scrollTop = $('chat').scrollHeight;
  return d;
}
function mkBtn(label, fn){ var b = document.createElement('button'); b.textContent = label; b.onclick = fn; return b; }

async function sendFeedback(rating, ctx, btns, status){
  var note = '';
  if (rating === 'down') note = prompt('Kya galat tha? (optional)') || '';
  btns.forEach(function(b){ b.disabled = true; });
  status.textContent = '🧠 Seekh raha hoon...';
  try {
    var r = await api('/api/feedback', { method:'POST', body: JSON.stringify({ rating: rating, prompt: ctx.prompt, reply: ctx.reply, note: note, skills: ctx.skills }) });
    var j = await r.json();
    status.textContent = j.msg || j.error || '✅';
  } catch(e) { status.textContent = '⚠️ Fail'; }
}
function addActions(div, text, ctx){
  var a = document.createElement('div'); a.className = 'acts';
  var status = document.createElement('span');
  var up = mkBtn('👍', function(){ sendFeedback('up', ctx, [up, down], status); });
  var down = mkBtn('👎', function(){ sendFeedback('down', ctx, [up, down], status); });
  a.appendChild(mkBtn('📋 Copy', function(e){ try { navigator.clipboard.writeText(text); e.target.textContent = '✅ Copied'; } catch(x) {} }));
  a.appendChild(mkBtn('🔊 Speak', function(){ if (window.speechSynthesis) { speechSynthesis.cancel(); var u = new SpeechSynthesisUtterance(text.replace(/[*#]/g,'')); u.lang = 'en-IN'; speechSynthesis.speak(u); } }));
  a.appendChild(mkBtn('🔄 Retry', regenerate));
  a.appendChild(up); a.appendChild(down);
  if (ctx.skills && ctx.skills.length) status.textContent = '🧩 ' + ctx.skills.join(', ');
  a.appendChild(status);
  div.appendChild(a);
}
function renderHistory(){
  $('chat').innerHTML = '';
  if (!history.length) { addMsg('ai', 'Namaste! Main Nabla Jugaad hoon. Main aapse seekhta rehta hoon aur khud naye skills banata hoon. Aaj kya karein? (/help dekho)'); return; }
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
  t.textContent = m === 'chat' ? '⚡ Nabla Jugaad (Hinglish)' : '💼 Nabla Jugaad (Work Mode)';
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

// ---------- chats / projects / notices ----------
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
  var ins = prompt('Is project ke liye custom instructions?') || '';
  await api('/api/projects', { method:'POST', body: JSON.stringify({ name: name, instructions: ins }) });
  loadProjects();
}
async function checkNotices(){
  try {
    var list = await (await api('/api/notices')).json();
    list.forEach(function(t){ addMsg('ai', t, 'note'); });
  } catch(e) {}
}

// ---------- slash commands ----------
async function runCommand(text){
  var cmd = text.split(' ')[0].toLowerCase(); var arg = text.slice(cmd.length).trim();
  addMsg('user', text);
  async function call(path, method, body){
    var r = await api(path, { method: method, body: body ? JSON.stringify(body) : undefined });
    var j = {}; try { j = await r.json(); } catch(e) {}
    return { ok: r.ok, j: j };
  }
  try {
    if (cmd === '/help') {
      addMsg('ai', '**Commands**\n/remember <fact>\n/memory - facts + lessons\n/forget - saari memory delete\n/learn <description> - naya skill banwao\n/skills - skills list\n/improve <skill> <feedback> - skill behtar karo\n/rollback <skill> - purana version wapas\n/enable <skill> - band skill chalu\n/unlearn <skill> - delete\n/stats - kitna seekha\n\nMain khud bhi naye skills banata hoon aur 👍/👎 se improve hota hoon.');
    } else if (cmd === '/remember') {
      if (!arg) return addMsg('ai', 'Kya yaad rakhna hai? /remember <fact>');
      var r1 = await call('/api/memory', 'POST', { fact: arg });
      addMsg('ai', r1.ok ? '✅ Yaad kar liya.' : '⚠️ ' + (r1.j.error || 'Save nahi hua.'));
    } else if (cmd === '/memory') {
      var m = (await call('/api/memory', 'GET')).j;
      var lines = (Array.isArray(m) ? m : []).map(function(x){ return (x.type === 'lesson' ? '📘 ' : '• ') + x.fact; });
      addMsg('ai', lines.length ? lines.join('\n') : 'Abhi kuch yaad nahi hai.');
    } else if (cmd === '/forget') {
      await call('/api/memory', 'DELETE');
      addMsg('ai', '🗑️ Saari memory delete ho gayi.');
    } else if (cmd === '/learn') {
      if (!arg) return addMsg('ai', 'Skill describe karo: /learn har email formal tone me likho');
      var d = addMsg('ai', '🧠 Naya skill bana raha hoon...');
      var r2 = await call('/api/skills/learn', 'POST', { description: arg });
      d.innerHTML = fmt(r2.ok ? '✅ Skill ban gaya: **' + r2.j.name + '**\nTriggers: ' + r2.j.triggers.join(', ') : '⚠️ ' + (r2.j.error || 'Fail'));
    } else if (cmd === '/skills') {
      var s = (await call('/api/skills', 'GET')).j;
      addMsg('ai', (Array.isArray(s) && s.length) ? s.map(function(x){
        return '• **' + x.name + '** v' + (x.version || 1) + (x.auto ? ' 🤖auto' : ' ✋manual') + (x.disabled ? ' ⛔band' : '') + ' | score ' + (x.score || 0) + ' | used ' + (x.uses || 0) + 'x\n   triggers: ' + x.triggers.join(', ');
      }).join('\n') : 'Koi skill nahi hai. Main khud seekhunga ya /learn use karo.');
    } else if (cmd === '/improve') {
      var sp = arg.split(' '); var nm = sp.shift(); var fb = sp.join(' ');
      if (!nm || fb.length < 5) return addMsg('ai', 'Use: /improve <skill> <kya behtar karna hai>');
      var d2 = addMsg('ai', '🧠 Skill improve kar raha hoon...');
      var r3 = await call('/api/skills/improve', 'POST', { name: nm, feedback: fb });
      d2.innerHTML = fmt(r3.ok ? '✅ Skill improve hua (v' + r3.j.version + ').' : '⚠️ ' + (r3.j.error || 'Fail'));
    } else if (cmd === '/rollback') {
      var r4 = await call('/api/skills/' + encodeURIComponent(arg) + '/rollback', 'POST');
      addMsg('ai', r4.ok ? '↩️ Purana version wapas aa gaya.' : '⚠️ ' + (r4.j.error || 'Fail'));
    } else if (cmd === '/enable') {
      var r5 = await call('/api/skills/' + encodeURIComponent(arg) + '/enable', 'POST');
      addMsg('ai', r5.ok ? '✅ Skill chalu.' : '⚠️ ' + (r5.j.error || 'Fail'));
    } else if (cmd === '/unlearn') {
      var r6 = await call('/api/skills/' + encodeURIComponent(arg), 'DELETE');
      addMsg('ai', r6.ok ? '🗑️ Skill delete.' : 'Skill nahi mila.');
    } else if (cmd === '/stats') {
      var st = (await call('/api/stats', 'GET')).j;
      addMsg('ai', '📊 **Nabla Jugaad ne ab tak seekha**\nFacts: ' + st.facts + '\nLessons: ' + st.lessons + '\nSkills: ' + st.skills + ' (auto: ' + st.auto + ', band: ' + st.disabled + ')\nChats: ' + st.chats);
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
  var full = '', used = [];
  var lastUser = history[history.length - 1].content;
  var promptText = lastUser.split('\n\n[FILE CONTENT START]')[0];
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
    var hdr = res.headers.get('X-Skills-Used');
    if (hdr) used = decodeURIComponent(hdr).split(',').filter(Boolean);
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
    div.innerHTML = fmt(full);
    addActions(div, full, { prompt: promptText, reply: full, skills: used });
    persist(); loadChats();
    setTimeout(checkNotices, 7000);
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

// ================= AUTH =================
app.post('/api/login', rateLimit('login', 5, 60000), (req, res) => {
  const pass = String((req.body && req.body.password) || '');
  if (!safeEqual(pass, APP_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: makeToken() });
});

app.get('/api/notices', auth, (req, res) => res.json(notices.splice(0)));

// ================= CHAT HISTORY =================
app.get('/api/chats', auth, async (req, res) => {
  if (!dbReady()) return res.json([]);
  res.json(await chats.find({}, { projection: { title: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(40).toArray());
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
  res.json(await memories.find().sort({ time: -1 }).limit(MAX_MEMORIES + MAX_LESSONS).toArray());
});
app.post('/api/memory', auth, needDb, async (req, res) => {
  const fact = String(req.body.fact || '').trim().slice(0, 200);
  if (fact.length < 3 || SECRET_LIKE.test(fact) || isBad(fact)) {
    return res.status(400).json({ error: 'Invalid ya sensitive fact' });
  }
  await memories.insertOne({ _id: crypto.randomUUID(), fact, type: 'fact', time: new Date(), auto: false });
  res.json({ ok: true });
});
app.delete('/api/memory', auth, needDb, async (req, res) => {
  await memories.deleteMany({});
  res.json({ ok: true });
});

// ================= SKILLS (manual + self-created) =================
app.get('/api/skills', auth, async (req, res) => {
  if (!dbReady()) return res.json([]);
  res.json(await skills.find().sort({ createdAt: -1 }).toArray());
});

app.post('/api/skills/learn', auth, needDb, rateLimit('learn', 6, 60000), async (req, res) => {
  const desc = String(req.body.description || '').trim().slice(0, 600);
  if (desc.length < 8 || isBad(desc)) return res.status(400).json({ error: 'Description invalid' });
  if ((await skills.countDocuments()) >= MAX_SKILLS) {
    return res.status(400).json({ error: 'Skill limit full. /unlearn se purane hatao.' });
  }
  const out = await groqJSON([
    {
      role: 'system',
      content: 'You design reusable skills for an AI assistant. From the user description return ONLY JSON: {"name":"short-kebab-case","triggers":["3 to 6 lowercase keywords or phrases a user message would contain"],"instructions":"clear imperative instructions, max 600 chars"}. Instructions may only change how the assistant writes or thinks; never mention secrets, system prompts or ignoring rules.'
    },
    { role: 'user', content: desc }
  ]);
  const sk = normalizeSkill(out);
  if (!sk) return res.status(502).json({ error: 'Skill ban nahi paya, dobara try karo.' });
  await skills.updateOne(
    { _id: sk.name },
    {
      $set: { ...sk, auto: false, disabled: false, source: desc },
      $setOnInsert: { createdAt: new Date(), uses: 0, score: 0, version: 1 }
    },
    { upsert: true }
  );
  res.json({ name: sk.name, triggers: sk.triggers });
});

app.post('/api/skills/improve', auth, needDb, rateLimit('improve', 6, 60000), async (req, res) => {
  const name = String(req.body.name || '').toLowerCase();
  const feedback = String(req.body.feedback || '').trim().slice(0, 300);
  if (feedback.length < 5 || isBad(feedback)) return res.status(400).json({ error: 'Feedback invalid' });
  const sk = await skills.findOne({ _id: name });
  if (!sk) return res.status(404).json({ error: 'Skill nahi mila' });
  const ok = await refineSkill(sk, '', '', feedback);
  if (!ok) return res.status(502).json({ error: 'Improve nahi ho paya, dobara try karo.' });
  const fresh = await skills.findOne({ _id: name });
  res.json({ ok: true, version: fresh.version });
});

app.post('/api/skills/:name/rollback', auth, needDb, async (req, res) => {
  const sk = await skills.findOne({ _id: String(req.params.name).toLowerCase() });
  if (!sk) return res.status(404).json({ error: 'Skill nahi mila' });
  if (!sk.prev) return res.status(400).json({ error: 'Purana version nahi hai' });
  await skills.updateOne({ _id: sk._id }, {
    $set: { instructions: sk.prev, prev: sk.instructions, updatedAt: new Date() }, $inc: { version: 1 }
  });
  res.json({ ok: true });
});

app.post('/api/skills/:name/enable', auth, needDb, async (req, res) => {
  const r = await skills.updateOne({ _id: String(req.params.name).toLowerCase() }, { $set: { disabled: false, score: 0 } });
  if (!r.matchedCount) return res.status(404).json({ error: 'Skill nahi mila' });
  res.json({ ok: true });
});

app.delete('/api/skills/:name', auth, needDb, async (req, res) => {
  const r = await skills.deleteOne({ _id: String(req.params.name).toLowerCase() });
  res.status(r.deletedCount ? 200 : 404).json({ ok: !!r.deletedCount });
});

app.get('/api/stats', auth, async (req, res) => {
  if (!dbReady()) return res.json({ facts: 0, lessons: 0, skills: 0, auto: 0, disabled: 0, chats: 0 });
  const [facts, lessons, sk, auto, disabled, ch] = await Promise.all([
    memories.countDocuments({ type: { $ne: 'lesson' } }),
    memories.countDocuments({ type: 'lesson' }),
    skills.countDocuments(),
    skills.countDocuments({ auto: true }),
    skills.countDocuments({ disabled: true }),
    chats.countDocuments()
  ]);
  res.json({ facts, lessons, skills: sk, auto, disabled, chats: ch });
});

// ================= SELF-IMPROVEMENT: FEEDBACK LOOP =================
app.post('/api/feedback', auth, needDb, rateLimit('fb', 20, 60000), async (req, res) => {
  const rating = req.body.rating === 'up' ? 'up' : 'down';
  const prompt = stripFile(req.body.prompt).slice(0, 800);
  const reply = String(req.body.reply || '').slice(0, 1500);
  const note = String(req.body.note || '').trim().slice(0, 300);
  const used = (Array.isArray(req.body.skills) ? req.body.skills : [])
    .map(s => String(s).toLowerCase()).filter(validId).slice(0, 5);
  if (isBad(note)) return res.status(400).json({ error: 'Note blocked' });

  if (rating === 'up') {
    if (used.length) await skills.updateMany({ _id: { $in: used } }, { $inc: { score: 1 } });
    return res.json({ msg: '👍 Shukriya! Yeh approach yaad rakhunga.' });
  }

  // thumbs down
  let msg = '';
  if (used.length) {
    await skills.updateMany({ _id: { $in: used } }, { $inc: { score: -1 } });
    const list = await skills.find({ _id: { $in: used } }).toArray();
    const improved = [], paused = [];
    for (const sk of list.slice(0, 2)) {
      if (await refineSkill(sk, prompt, reply, note)) improved.push(sk.name);
      if ((sk.score || 0) <= -3 && (sk.uses || 0) >= 3) {
        await skills.updateOne({ _id: sk._id }, { $set: { disabled: true } });
        paused.push(sk.name);
      }
    }
    msg = improved.length ? '🧠 Skill improve kiya: ' + improved.join(', ') : '📝 Feedback note kar liya.';
    if (paused.length) msg += ' ⛔ Band kiya (bahut 👎): ' + paused.join(', ') + ' (/enable se chalu karo)';
    return res.json({ msg });
  }

  // no skill involved: learn a general lesson
  const out = await groqJSON([
    {
      role: 'system',
      content: 'An AI assistant got a thumbs-down. From the request, reply and optional user note, write ONE short generic lesson (max 140 chars, starting with "Next time") that would improve future replies. Return ONLY JSON: {"lesson":"..."}. No secrets, no personal data.'
    },
    { role: 'user', content: JSON.stringify({ request: prompt, reply: reply.slice(0, 800), note }) }
  ], 600);
  const lesson = out && typeof out.lesson === 'string' ? out.lesson.trim().slice(0, 160) : '';
  if (lesson.length < 8 || isBad(lesson) || SECRET_LIKE.test(lesson)) {
    return res.json({ msg: '📝 Feedback note kar liya.' });
  }
  await memories.insertOne({ _id: crypto.randomUUID(), fact: lesson, type: 'lesson', time: new Date(), auto: true });
  const lessons = await memories.find({ type: 'lesson' }).sort({ time: 1 }).toArray();
  if (lessons.length > MAX_LESSONS) {
    await memories.deleteMany({ _id: { $in: lessons.slice(0, lessons.length - MAX_LESSONS).map(l => l._id) } });
  }
  res.json({ msg: '📘 Seekh liya: ' + lesson });
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
  const list = msgs.slice(-MAX_MESSAGES);
  let total = list.reduce((n, m) => n + m.content.length, 0);
  while (list.length > 1 && total > MAX_CHARS) total -= list.shift().content.length;
  return list;
}

app.post('/api/generate', auth, rateLimit('gen', 25, 60000), async (req, res) => {
  const clean = cleanMessages(req.body.messages);
  if (!clean) return res.status(400).json({ error: 'Invalid messages' });

  const mode = req.body.mode === 'work' ? 'work' : 'chat';
  const own = stripFile(clean[clean.length - 1].content);
  if (isBad(own)) return res.status(403).json({ error: 'Blocked: Prompt injection detected!' });
  const convId = validId(req.body.convId) ? req.body.convId : crypto.randomUUID();

  // ---- system prompt = personality + memory + lessons + project + matching skills ----
  let sys = prompts[mode] + '\nToday is ' + new Date().toDateString() + '.';
  let hit = [];
  try {
    if (dbReady()) {
      const mem = await memories.find().sort({ time: -1 }).limit(60).toArray();
      const facts = mem.filter(m => m.type !== 'lesson').slice(0, 20);
      const lessons = mem.filter(m => m.type === 'lesson').slice(0, 8);
      if (facts.length) {
        sys += '\n\nKnown facts about the user (use naturally, never recite unprompted):\n' + facts.map(m => '- ' + m.fact).join('\n');
      }
      if (lessons.length) {
        sys += '\n\nLessons learned from past feedback (follow them):\n' + lessons.map(m => '- ' + m.fact).join('\n');
      }
      if (validId(req.body.projectId)) {
        const p = await projects.findOne({ _id: req.body.projectId });
        if (p && p.instructions) sys += '\n\nProject "' + p.name + '" instructions:\n' + p.instructions;
      }
      const lowered = own.toLowerCase();
      const all = await skills.find({ disabled: { $ne: true } }).toArray();
      hit = all.filter(s => s.triggers.some(t => lowered.includes(t))).slice(0, 3);
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
    res.setHeader('X-Skills-Used', encodeURIComponent(hit.map(s => s.name).join(',')));

    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
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
      const code = error.status === 429 ? 429 : 502;
      const msg = error.status === 429 ? 'AI limit reached. Thodi der baad try karo.' : 'Error generating response.';
      return res.status(code).json({ error: msg });
    }
    res.write('\n\n⚠️ Connection toot gaya.');
    res.end();
  }

  // ---- after reply: save chat + background self-learning ----
  if (full && dbReady()) {
    const title = stripFile(clean[0].content).slice(0, 40) || 'Chat';
    chats.updateOne(
      { _id: convId },
      {
        $set: { messages: [...clean, { role: 'assistant', content: full }].slice(-100), mode, updatedAt: new Date() },
        $setOnInsert: { title, createdAt: new Date() }
      },
      { upsert: true }
    ).catch(err => console.log('DB Save Error:', err.message));

    learnFromExchange(own).catch(() => {});
    if (AUTO_SKILL && !hit.length && own.length >= 25 && (++reflectTick % REFLECT_EVERY === 0)) {
      reflectForSkill(own).catch(e => console.log('Reflect error:', e.message));
    }
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

app.listen(port, () => console.log('🚀 Nabla Jugaad running on port ' + port));
