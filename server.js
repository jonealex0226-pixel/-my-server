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
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const SECRET = process.env.SESSION_SECRET || APP_PASSWORD;
const MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-20b,llama-3.1-8b-instant').split(',').map(s => s.trim()).filter(Boolean);
const MAX_MESSAGES = 20;
const MAX_MEMORIES = 50;

if (!APP_PASSWORD) {
  console.error('❌ APP_PASSWORD env var missing. Set it in Render > Environment.');
  process.exit(1);
}

app.use(express.json({ limit: '200kb' }));

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
      console.log('✅ Connected to MongoDB');
    })
    .catch(err => console.log('❌ MongoDB Error:', err.message));
}
const dbReady = () => !!(chats && memories && skills);

// ================= SECURITY =================
function sign(exp) { return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex'); }
function makeToken() { const exp = Date.now() + 30 * 24 * 3600 * 1000; return exp + '.' + sign(exp); }
function verifyToken(t) {
  const [exp, sig] = String(t || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!verifyToken(t)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const badPatterns = [/ignore (all )?(previous|prior) instructions/i, /(print|reveal|show) (your )?system prompt/i];
const isBad = s => badPatterns.some(p => p.test(s));
const SECRET_LIKE = /(password|passwd|api[_ -]?key|secret|token|otp|\b\d{12,}\b)/i;

// ================= GROQ HELPERS =================
function getKey() { return (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, ''); }

async function groqFetch(payload) {
  const key = getKey();
  if (!key) throw new Error('API key missing');
  let last = 0;
  for (const model of MODELS) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ ...payload, model })
      });
      if (r.ok) return r;
      last = r.status;
    } catch (e) {}
  }
  throw new Error('upstream ' + last);
}

async function groqJSON(messages) {
  try {
    const r = await groqFetch({ messages, stream: false, max_tokens: 500, temperature: 0.1 });
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { return null; }
}

// ================= SELF-LEARNING LOGIC =================
async function learnFromExchange(userText) {
  if (!dbReady() || userText.length < 15 || userText.startsWith('/')) return;
  
  const out = await groqJSON([
    { role: 'system', content: 'Extract durable personal facts the USER stated about themselves (name, job, likes). Return ONLY a JSON array of up to 3 short strings, or []. Never include passwords/keys.' },
    { role: 'user', content: userText.slice(0, 1000) }
  ]);
  
  if (!Array.isArray(out)) return;
  for (const f of out.slice(0, 3)) {
    if (typeof f !== 'string' || f.length < 4 || SECRET_LIKE.test(f)) continue;
    const exists = await memories.findOne({ fact: f.trim() });
    if (!exists) await memories.insertOne({ _id: crypto.randomUUID(), fact: f.trim(), time: new Date() });
  }
  const count = await memories.countDocuments();
  if (count > MAX_MEMORIES) {
    const old = await memories.find().sort({ time: 1 }).limit(count - MAX_MEMORIES).toArray();
    await memories.deleteMany({ _id: { $in: old.map(o => o._id) } });
  }
}

// ================= AI ENDPOINT =================
app.post('/api/generate', auth, async (req, res) => {
  let messages = req.body.messages;
  const mode = req.body.mode || 'chat';
  let userPrompt = messages[messages.length - 1].content;
  const convId = req.body.convId || crypto.randomUUID();

  if (isBad(userPrompt)) return res.status(403).send("Blocked: Prompt injection detected!");

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  // --- COMMAND HANDLING ---
  if (userPrompt.startsWith('/')) {
    const cmd = userPrompt.split(' ')[0].toLowerCase();
    const arg = userPrompt.slice(cmd.length).trim();
    
    if (cmd === '/remember' && arg) {
      if (SECRET_LIKE.test(arg)) { res.write("I cannot save passwords or secrets."); return res.end(); }
      await memories.insertOne({ _id: crypto.randomUUID(), fact: arg, time: new Date() });
      res.write("Got it. I have saved that to my memory."); return res.end();
    }
    
    if (cmd === '/memory') {
      if (!dbReady()) { res.write("Database is offline."); return res.end(); }
      const mems = await memories.find().toArray();
      res.write("Here is what I know about you:\n\n" + (mems.length ? mems.map(m => "• " + m.fact).join('\n') : "Nothing yet."));
      return res.end();
    }
    
    if (cmd === '/forget') {
      if (dbReady()) await memories.deleteMany({});
      res.write("Memory wiped clean."); return res.end();
    }

    if (cmd === '/learn' && arg) {
      res.write("Learning new skill, please wait...\n\n");
      const skillData = await groqJSON([
        { role: 'system', content: 'Create a skill based on the user description. Return JSON only: {"name": "ShortName", "triggers": ["word1", "word2"], "instructions": "Detailed system prompt instructions"}' },
        { role: 'user', content: arg }
      ]);
      if (skillData && skillData.name && skillData.instructions) {
        await skills.insertOne({ _id: crypto.randomUUID(), ...skillData, time: new Date() });
        res.write(`✅ Skill '${skillData.name}' learned!\nTriggers: ${skillData.triggers.join(', ')}`);
      } else {
        res.write("Failed to generate skill format.");
      }
      return res.end();
    }

    if (cmd === '/skills') {
      if (!dbReady()) { res.write("Database is offline."); return res.end(); }
      const sks = await skills.find().toArray();
      res.write("My Skills:\n\n" + (sks.length ? sks.map(s => `• **${s.name}** (Triggers: ${s.triggers.join(', ')})`).join('\n') : "No skills learned yet."));
      return res.end();
    }

    if (cmd === '/unlearn' && arg) {
      if (dbReady()) await skills.deleteOne({ name: new RegExp(arg, 'i') });
      res.write(`Skill matching '${arg}' deleted.`); return res.end();
    }
  }

  // --- NORMAL AI CHAT ---
  let sysPrompt = mode === 'chat' 
    ? "You are Nabla AI, a helpful, witty AI assistant. Reply in natural Hinglish (mix of Hindi and English). Keep answers concise. Use markdown."
    : "You are Nabla AI in WORK MODE. Provide detailed, analytical, step-by-step answers in professional English using markdown.";

  // Inject Memories
  if (dbReady()) {
    const mems = await memories.find().limit(MAX_MEMORIES).toArray();
    if (mems.length > 0) sysPrompt += "\n\n[USER MEMORY]\n" + mems.map(m => "- " + m.fact).join('\n');
    
    // Inject Matching Skills
    const sks = await skills.find().toArray();
    const matched = sks.filter(s => s.triggers.some(t => userPrompt.toLowerCase().includes(t.toLowerCase())));
    if (matched.length > 0) {
      sysPrompt += "\n\n[ACTIVE SKILLS]\n" + matched.map(s => `Skill: ${s.name}\nInstructions: ${s.instructions}`).join('\n');
    }
  }

  try {
    const response = await groqFetch({
      messages: [{ role: "system", content: sysPrompt }, ...messages.slice(-MAX_MESSAGES)],
      stream: true
    });

    let fullReply = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            const content = data.choices[0]?.delta?.content || "";
            if (content) { fullReply += content; res.write(content); }
          } catch (e) {}
        }
      }
    }
    res.end();

    // Save to DB
    if (dbReady()) {
      await chats.updateOne(
        { _id: convId },
        { 
          $push: { messages: { $each: [{ role: 'user', content: userPrompt }, { role: 'assistant', content: fullReply }] } },
          $set: { updatedAt: new Date(), title: userPrompt.slice(0, 30) },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );
      // Trigger background learning
      learnFromExchange(userPrompt).catch(() => {});
    }
  } catch (error) {
    res.write("Error generating response.");
    res.end();
  }
});

// ================= FRONTEND & API ROUTES =================
app.post('/api/login', (req, res) => { if (req.body.password !== APP_PASSWORD) return res.status(401).json({ error: 'Wrong' }); res.json({ token: makeToken() }); });
app.get('/api/chats', auth, async (req, res) => { if (!dbReady()) return res.json([]); res.json(await chats.find({}, { projection: { messages: 0 } }).sort({ updatedAt: -1 }).limit(30).toArray()); });
app.get('/api/chats/:id', auth, async (req, res) => { if (!dbReady()) return res.status(404).json({}); res.json(await chats.findOne({ _id: req.params.id }) || {}); });
app.delete('/api/chats/:id', auth, async (req, res) => { if (dbReady()) await chats.deleteOne({ _id: req.params.id }); res.json({ ok: true }); });

setInterval(() => { if (process.env.RENDER_EXTERNAL_URL) fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {}); }, 14 * 60 * 1000);
app.get('/health', (req, res) => res.send('OK'));

app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
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
<div id="chatlist"></div>
<div class="mt">
<button class="mb active" id="btn-chat" onclick="setMode('chat')">Chat</button>
<button class="mb" id="btn-work" onclick="setMode('work')">Work</button>
</div>
<div style="font-size:11px; color:#94a3b8; text-align:center; margin-top:10px;">
Type /help in chat for commands
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
var mode = 'chat', attached = '', busy = false;
var history = [];
var convId = newId();
try {
  var saved = JSON.parse(localStorage.getItem('nabla_current'));
  if (saved && saved.id) { convId = saved.id; history = saved.messages || []; }
} catch(e) {}

function newId(){ return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2); }
function persist(){ try { localStorage.setItem('nabla_current', JSON.stringify({ id: convId, messages: history.slice(-60) })); } catch(e) {} }
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

function showLogin(){ $('login').style.display = 'flex'; }
async function doLogin(){
  try {
    var r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: $('loginPass').value }) });
    if (!r.ok) { $('loginErr').style.display = 'block'; return; }
    var d = await r.json(); token = d.token;
    try { localStorage.setItem('nabla_token', token); } catch(e) {}
    $('login').style.display = 'none'; $('loginErr').style.display = 'none'; $('loginPass').value = '';
    loadChats();
  } catch(e) { $('loginErr').textContent = 'Network error'; $('loginErr').style.display = 'block'; }
}
async function api(path, opts){
  opts = opts || {};
  var h = Object.assign({ 'Content-Type':'application/json', 'Authorization':'Bearer ' + token }, opts.headers || {});
  var r = await fetch(path, Object.assign({}, opts, { headers: h }));
  if (r.status === 401) { showLogin(); throw new Error('auth'); }
  return r;
}

function addMsg(role, text){
  var d = document.createElement('div');
  d.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  if (role === 'user') d.textContent = text; else d.innerHTML = fmt(text);
  $('chat').appendChild(d);
  $('chat').scrollTop = $('chat').scrollHeight;
  return d;
}
function renderHistory(){
  $('chat').innerHTML = '';
  if (!history.length) { addMsg('ai', 'Namaste! Main Nabla AI hoon. Aaj main aapki kya madad kar sakta hoon? (Type /help for commands)'); return; }
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
  if (f.size > 300000) { addMsg('ai', '⚠️ File max 300KB.'); return; }
  var r = new FileReader();
  r.onload = function(ev){ attached = ev.target.result; $('promptInput').value += ' [Attached: ' + f.name + '] '; };
  r.readAsText(f);
}
function startVoice(){
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert('Voice not supported.');
  var rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = false;
  $('micBtn').classList.add('rec');
  rec.onresult = function(e){ $('promptInput').value += e.results[0][0].transcript; };
  rec.onend = function(){ $('micBtn').classList.remove('rec'); };
  rec.start();
}

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

async function onSend(e){
  if (busy) return;
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  var input = $('promptInput'); var text = input.value.trim();
  if (!text && !attached) return;
  var finalText = text;
  if (attached) finalText += '\n\n[FILE CONTENT START]\n' + attached + '\n[FILE CONTENT END]';

  addMsg('user', text);
  history.push({ role: 'user', content: finalText });
  input.value = ''; attached = ''; persist();
  
  busy = true; $('sendBtn').textContent = 'Stop'; $('sendBtn').classList.add('stop');
  var aiDiv = addMsg('ai', '...');
  var fullReply = '';

  try {
    var res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ messages: history, mode: mode, convId: convId })
    });
    if (!res.ok) throw new Error(await res.text());
    
    var reader = res.body.getReader(); var decoder = new TextDecoder();
    while (true) {
      var { done, value } = await reader.read(); if (done) break;
      var chunk = decoder.decode(value);
      fullReply += chunk;
      aiDiv.innerHTML = fmt(fullReply);
      $('chat').scrollTop = $('chat').scrollHeight;
    }
    history.push({ role: 'assistant', content: fullReply });
    persist();
  } catch(err) {
    aiDiv.innerHTML = '❌ ' + err.message;
  }
  busy = false; $('sendBtn').textContent = 'Send'; $('sendBtn').classList.remove('stop');
}

window.onload = function(){
  setTimeout(function(){ var b = $('boot'); if(b) b.remove(); }, 2000);
  if (!token) { showLogin(); } else { renderHistory(); loadChats(); }
};
</script>
</body>
</html>`);
});

app.listen(port, () => console.log(`🚀 Nabla AI Server running on port ${port}`));
