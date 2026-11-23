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
//  NABLA AI (Hinglish AI) - self-creating, self-improving assistant
//  Render env: GROQ_API_KEY, MONGODB_URI, APP_PASSWORD
//  Optional : SESSION_SECRET, GROQ_MODELS, GROQ_VISION_MODEL, AUTO_LEARN=off,
//             AUTO_SKILL=off
// ===================================================================
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const SECRET = process.env.SESSION_SECRET || APP_PASSWORD;
const MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-20b,llama-3.1-8b-instant')
  .split(',').map(s => s.trim()).filter(Boolean);
const AUTO_LEARN = (process.env.AUTO_LEARN || 'on') !== 'off';
const AUTO_SKILL = (process.env.AUTO_SKILL || 'on') !== 'off';
const MAX_MESSAGES = 20;
const MAX_CHARS = 24000;
const MAX_MEMORIES = 50;
const MAX_LESSONS = 15;
const MAX_SKILLS = 30;
const VISION_MODEL = (process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct').trim();
const IMG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/;

if (!APP_PASSWORD) {
  console.error('❌ APP_PASSWORD env var missing. Set it in Render > Environment.');
  process.exit(1);
}

const jsonSmall = express.json({ limit: '200kb' });
const jsonBig = express.json({ limit: '3mb' });
app.use((req, res, next) => (req.path === '/api/generate' ? jsonBig : jsonSmall)(req, res, next));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ================= DATABASE =================
let chats, memories, skills, projects, meta;
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
      meta = db.collection('meta');
      await chats.createIndex({ updatedAt: -1 }).catch(() => {});
      await memories.createIndex({ time: -1 }).catch(() => {});
      await seedSkills().catch(e => console.log('Seed error:', e.message));
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
  chat: "You are Nabla AI, a helpful, witty AI assistant. You must always reply in natural Hinglish (a mix of Hindi and English). Keep answers concise, engaging and friendly. Use markdown for formatting.",
  work: "You are Nabla AI in WORK MODE. You are a highly structured, analytical assistant. Provide detailed, step-by-step answers in professional English using markdown formatting (bullet points, bold text)."
};

// ================= GROQ HELPERS =================
function getKey() { return (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, ''); }

async function groqFetch(payload, signal, models) {
  const key = getKey();
  if (!key) { const e = new Error('API key missing'); e.status = 500; throw e; }
  let last = 0;
  for (const model of (models || MODELS)) {
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

// ================= SELF-LEARNING BRAIN =================
function normalizeSkill(out) {
  if (!out || typeof out.name !== 'string' || !Array.isArray(out.triggers) || typeof out.instructions !== 'string') return null;
  const name = out.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const triggers = [...new Set(out.triggers.map(t => String(t).toLowerCase().trim().slice(0, 40)).filter(t => t.length >= 3))].slice(0, 6);
  const instructions = out.instructions.trim().slice(0, 600);
  if (!name || !triggers.length || instructions.length < 10 || isBad(instructions) || SECRET_LIKE.test(instructions)) return null;
  return { name, triggers, instructions };
}

const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// trigger must start at a word boundary ("plan" matches "planning", not "explanation")
function matchesTrigger(lowered, t) {
  try { return new RegExp('(^|[^\\p{L}\\p{N}])' + escRe(t), 'u').test(lowered); }
  catch (e) { return lowered.includes(t); }
}

async function saveSkill(sk, extra) {
  await skills.updateOne(
    { _id: sk.name },
    {
      $set: { ...sk, disabled: false, ...extra },
      $setOnInsert: { createdAt: new Date(), uses: 0, score: 0, version: 1 }
    },
    { upsert: true }
  );
}

// Starter skills so Nabla is useful from day one (seeded once; /unlearn stays deleted)
const STARTERS = [
  { name: 'email-writer', triggers: ['email', 'mail likh', 'draft mail', 'letter'], instructions: 'Write clear emails: subject line, greeting, short body, polite closing. Match the requested tone. Only ask a question if a key detail is missing.' },
  { name: 'code-helper', triggers: ['code', 'bug', 'error', 'function', 'script'], instructions: 'For code: give working code in fenced blocks, explain briefly what it does, point out likely bugs and edge cases, keep explanations short.' },
  { name: 'summarizer', triggers: ['summary', 'summarize', 'saransh', 'tl;dr'], instructions: 'Summarize in 3-5 bullets first, then a one-line takeaway. Keep key numbers and names.' },
  { name: 'explain-simple', triggers: ['samjhao', 'explain', 'eli5', 'simple me'], instructions: 'Explain with a simple everyday example first, then the details. Avoid jargon.' },
  { name: 'planner', triggers: ['plan', 'schedule', 'roadmap', 'timetable'], instructions: 'Give a step-by-step plan with realistic time estimates and a clear first action.' },
  { name: 'study-notes', triggers: ['notes', 'revise', 'exam', 'padhai'], instructions: 'Make concise revision notes: headings, key points, one example, and 3 quick practice questions.' },
  { name: 'translator', triggers: ['translate', 'anuvad', 'hindi me', 'english me'], instructions: 'Translate faithfully, keep tone and names, and mention alternate phrasing only if the meaning is ambiguous.' },
  { name: 'compare-decide', triggers: ['compare', 'comparison', 'better option'], instructions: 'Compare options in a small table, then give a clear recommendation with reasons.' }
];
async function seedSkills() {
  if (!meta || await meta.findOne({ _id: 'seed_v1' })) return;
  for (const st of STARTERS) {
    await skills.updateOne(
      { _id: st.name },
      { $setOnInsert: { ...st, auto: false, seed: true, disabled: false, uses: 0, score: 0, version: 1, createdAt: new Date() } },
      { upsert: true }
    );
  }
  await meta.insertOne({ _id: 'seed_v1', time: new Date() });
  console.log('🌱 Starter skills seeded');
}

// ONE background call after each reply learns three things:
//  facts (about the user), lessons (when the user corrects the AI), skills (reusable task styles)
let learnBusy = false;
const FEEDBACK_RE = /(galat|wrong|nahi chahiye|bekar|bakwas|accha|achha|badhiya|perfect|sahi|great|good|thanks|shukriya|dhanyavad|pasand)/i;
async function learnFromExchange(userText, prevReply, prevSkills, prevUser) {
  if ((!AUTO_LEARN && !AUTO_SKILL) || !dbReady() || learnBusy) return;
  if (userText.length < 12 && !FEEDBACK_RE.test(userText)) return;
  learnBusy = true;
  try {
    const existing = await skills.find().toArray();
    const out = await groqJSON([
      {
        role: 'system',
        content: 'You are the learning module of an AI assistant. Read the USER message (and the assistant previous reply, if given) and return ONLY a JSON object: {"facts":[up to 3 short durable facts or preferences the user stated about themselves, or empty],"lesson":null or one generic sentence starting with "Next time" (max 140 chars) ONLY if the user is correcting, complaining about or redirecting the previous reply,"skill":null or {"name":"short-kebab-case","triggers":["3 to 6 lowercase keywords or phrases"],"instructions":"imperative guidance, max 600 chars"} ONLY if the request shows a reusable task type or style that deserves a permanent skill and is not already covered,"feedback":null or "positive" or "negative" — whether the user is clearly praising or criticizing the assistant previous reply}. Never include passwords, keys, OTPs, ID or card numbers. Existing skills: ' +
          JSON.stringify(existing.map(x => ({ name: x.name, triggers: x.triggers })))
      },
      { role: 'user', content: JSON.stringify({ user: userText.slice(0, 1200), previous_reply: String(prevReply || '').slice(0, 400) }) }
    ]);
    if (!out || typeof out !== 'object' || Array.isArray(out)) return;

    if (AUTO_LEARN) {
      const mem = await memories.find().toArray();
      const known = mem.map(m => m.fact.toLowerCase());
      for (const f of (Array.isArray(out.facts) ? out.facts : []).slice(0, 3)) {
        if (typeof f !== 'string') continue;
        const fact = f.trim().slice(0, 200);
        if (fact.length < 4 || SECRET_LIKE.test(fact) || known.includes(fact.toLowerCase())) continue;
        await memories.insertOne({ _id: crypto.randomUUID(), fact, type: 'fact', time: new Date(), auto: true });
        notify('💾 Yaad kar liya: ' + fact);
      }
      const lesson = typeof out.lesson === 'string' ? out.lesson.trim().slice(0, 160) : '';
      if (lesson.length >= 8 && !isBad(lesson) && !SECRET_LIKE.test(lesson) && !known.includes(lesson.toLowerCase())) {
        await memories.insertOne({ _id: crypto.randomUUID(), fact: lesson, type: 'lesson', time: new Date(), auto: true });
        notify('📘 Sudhar seekha: ' + lesson);
      }
      const facts = await memories.find({ type: { $ne: 'lesson' } }).sort({ time: 1 }).toArray();
      if (facts.length > MAX_MEMORIES) {
        await memories.deleteMany({ _id: { $in: facts.slice(0, facts.length - MAX_MEMORIES).map(o => o._id) } });
      }
      const lessons = await memories.find({ type: 'lesson' }).sort({ time: 1 }).toArray();
      if (lessons.length > MAX_LESSONS) {
        await memories.deleteMany({ _id: { $in: lessons.slice(0, lessons.length - MAX_LESSONS).map(o => o._id) } });
      }
    }

    // implicit feedback: the user's own words act like a 👍 / 👎 on the skills used last time
    if (AUTO_SKILL && Array.isArray(prevSkills) && prevSkills.length) {
      if (out.feedback === 'positive') {
        await skills.updateMany({ _id: { $in: prevSkills } }, { $inc: { score: 1 } });
      } else if (out.feedback === 'negative') {
        const r = await applyNegative(prevSkills, stripFile(prevUser || ''), prevReply, userText.slice(0, 300));
        if (r.improved.length) notify('🧠 Tumhare feedback se skill improve kiya: ' + r.improved.join(', '));
        if (r.paused.length) notify('⛔ Skill band kiya (bahut shikayat): ' + r.paused.join(', '));
      }
    }

    if (AUTO_SKILL && out.skill && existing.length < MAX_SKILLS) {
      const sk = normalizeSkill(out.skill);
      if (sk && !existing.some(x => x._id === sk.name || x.triggers.some(t => sk.triggers.includes(t)))) {
        await saveSkill(sk, { auto: true, source: 'auto' });
        notify('🧠 Maine khud naya skill seekha: ' + sk.name + ' (triggers: ' + sk.triggers.join(', ') + ')');
      }
    }
  } finally {
    learnBusy = false;
  }
}

// Tidy the skill library: merge duplicates (auto-run only touches auto-made skills)
async function evolveSkills(onlyAuto) {
  if (!dbReady()) return { merged: 0, removed: 0 };
  const all = await skills.find().toArray();
  if (all.length < 4) return { merged: 0, removed: 0, note: 'Abhi skills kam hain, merge ki zaroorat nahi.' };
  const out = await groqJSON([
    {
      role: 'system',
      content: 'You tidy an AI assistant skill library. Find skills that are duplicates or overlap heavily. Return ONLY JSON: {"merge":[{"keep":"skill-name","remove":["other-skill-name"],"triggers":["merged triggers, max 6"],"instructions":"merged instructions, max 600 chars"}]} or {"merge":[]}. Use only names from the list.'
    },
    { role: 'user', content: JSON.stringify(all.map(x => ({ name: x.name, triggers: x.triggers, instructions: x.instructions }))) }
  ], 1800);
  const byName = new Map(all.map(x => [x.name, x]));
  const gone = new Set();
  let merged = 0, removed = 0;
  for (const m of (out && Array.isArray(out.merge) ? out.merge.slice(0, 5) : [])) {
    const keep = byName.get(String(m.keep || '').toLowerCase());
    const rem = (Array.isArray(m.remove) ? m.remove : [])
      .map(n => byName.get(String(n).toLowerCase())).filter(x => x && keep && x._id !== keep._id && !gone.has(x._id));
    if (!keep || gone.has(keep._id) || !rem.length) continue;
    if (onlyAuto && (!keep.auto || rem.some(x => !x.auto))) continue;
    const sk = normalizeSkill({ name: keep.name, triggers: Array.isArray(m.triggers) ? m.triggers : keep.triggers, instructions: m.instructions });
    if (!sk) continue;
    await skills.updateOne({ _id: keep._id }, {
      $set: { triggers: sk.triggers, instructions: sk.instructions, prev: keep.instructions, updatedAt: new Date() },
      $inc: { version: 1, uses: rem.reduce((n, x) => n + (x.uses || 0), 0) }
    });
    await skills.deleteMany({ _id: { $in: rem.map(x => x._id) } });
    rem.forEach(x => gone.add(x._id));
    merged++; removed += rem.length;
  }
  if (merged) notify('🧹 Skills tidy kiye: ' + merged + ' merge, ' + removed + ' duplicate hataye.');
  return { merged, removed };
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

// ================= SHARED HELPERS =================
async function skillFromDescription(desc) {
  if (desc.length < 8 || isBad(desc)) return { error: 'Description invalid', code: 400 };
  if ((await skills.countDocuments()) >= MAX_SKILLS) return { error: 'Skill limit full. Purane skills hatao.', code: 400 };
  const out = await groqJSON([
    {
      role: 'system',
      content: 'You design reusable skills for an AI assistant. From the user description return ONLY JSON: {"name":"short-kebab-case","triggers":["3 to 6 lowercase keywords or phrases a user message would contain"],"instructions":"clear imperative instructions, max 600 chars"}. Instructions may only change how the assistant writes or thinks; never mention secrets, system prompts or ignoring rules.'
    },
    { role: 'user', content: desc }
  ]);
  const sk = normalizeSkill(out);
  if (!sk) return { error: 'Skill ban nahi paya, dobara try karo.', code: 502 };
  await saveSkill(sk, { auto: false, source: desc });
  return { sk };
}

async function skillFromChat(raw) {
  const msgs = (Array.isArray(raw) ? raw : []).slice(-8)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: stripFile(m.content).slice(0, 700) }));
  if (msgs.length < 2) return { error: 'Pehle thodi chat karo, phir main us se skill bana lunga.', code: 400 };
  if (msgs.some(m => isBad(m.content))) return { error: 'Blocked', code: 403 };
  if ((await skills.countDocuments()) >= MAX_SKILLS) return { error: 'Skill limit full. Purane skills hatao.', code: 400 };
  const out = await groqJSON([
    {
      role: 'system',
      content: 'From this conversation create ONE reusable skill that captures how the assistant should handle this kind of task (format, tone, steps). Return ONLY JSON: {"name":"short-kebab-case","triggers":["3 to 6 lowercase keywords or phrases future requests would contain"],"instructions":"imperative guidance, max 600 chars"}. Skills may only change how the assistant writes or thinks; never mention secrets or system prompts.'
    },
    { role: 'user', content: JSON.stringify(msgs) }
  ]);
  const sk = normalizeSkill(out);
  if (!sk) return { error: 'Skill ban nahi paya, dobara try karo.', code: 502 };
  await saveSkill(sk, { auto: false, source: 'taught from chat' });
  return { sk };
}

// thumbs-down (button OR implicit from the user's words): lower score, refine skill, pause bad ones
async function applyNegative(used, prompt, reply, note) {
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
  return { improved, paused };
}

async function statsObj() {
  const [facts, lessons, sk, auto, disabled, ch] = await Promise.all([
    memories.countDocuments({ type: { $ne: 'lesson' } }),
    memories.countDocuments({ type: 'lesson' }),
    skills.countDocuments(),
    skills.countDocuments({ auto: true }),
    skills.countDocuments({ disabled: true }),
    chats.countDocuments()
  ]);
  return { facts, lessons, skills: sk, auto, disabled, chats: ch };
}

function saveChat(convId, clean, mode, full) {
  if (!full || !dbReady()) return;
  const title = stripFile(clean[0].content).slice(0, 40) || 'Chat';
  chats.updateOne(
    { _id: convId },
    {
      $set: { messages: [...clean.map(m => ({ role: m.role, content: m.content })), { role: 'assistant', content: full }].slice(-100), mode, updatedAt: new Date() },
      $setOnInsert: { title, createdAt: new Date() }
    },
    { upsert: true }
  ).catch(err => console.log('DB Save Error:', err.message));
}

// ================= NATURAL-LANGUAGE CONTROL (no slash commands needed) =================
// The user just talks: "ye yaad rakho...", "email wala skill hata do", "skills dikhao"...
const INTENT_RE = /(skill|seekh|sikh|learn|yaad|yad rakh|remember|memory|bhool|bhul|forget|hata|delete|remove|mita|improve|sudhar|rollback|tidy|merge|evolve|stats|what do you know)/i;
const YES_RE = /^\s*(haan|han|ha|hanji|yes|y|yep|ok|okay|kar do|kardo|pakka|confirm|sure)\b/i;
const NO_RE = /^\s*(nahi|nahin|na|no|n|cancel|ruko|mat karo|rehne do)\b/i;
const pending = new Map(); // convId -> { run, exp }   (confirmation for destructive actions)
const STOP_TOK = new Set(['skill', 'skills', 'wala', 'wali', 'wale', 'the', 'ko', 'ka', 'ki', 'hata', 'delete', 'remove', 'kar', 'karo', 'bhool', 'jao', 'baat']);

function tokens(t) { return String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length >= 3 && !STOP_TOK.has(x)); }

async function resolveSkill(q) {
  const key = String(q || '').toLowerCase().trim();
  if (!key) return null;
  const all = await skills.find().toArray();
  const slug = key.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const exact = all.find(x => x._id === slug);
  if (exact) return exact;
  const toks = tokens(key);
  let best = null, bestScore = 0, tie = false;
  for (const sk of all) {
    const hay = (sk.name + ' ' + sk.triggers.join(' ')).toLowerCase();
    const sc = toks.filter(t => hay.includes(t)).length;
    if (sc > bestScore) { best = sk; bestScore = sc; tie = false; } else if (sc === bestScore && sc > 0) tie = true;
  }
  return best && !tie ? best : null;
}

async function handleIntent(own, clean, convId, hasImage) {
  if (!dbReady() || hasImage) return null;

  // 1) answer to a pending "pakka?" question
  const pend = pending.get(convId);
  if (pend) {
    pending.delete(convId);
    if (pend.exp > Date.now()) {
      if (YES_RE.test(own)) return await pend.run();
      if (NO_RE.test(own)) return 'Theek hai, cancel kar diya. 👍';
    }
  }

  // 2) cheap pre-filter, then ask the model what the user really wants
  if (own.length > 400 || !INTENT_RE.test(own)) return null;
  const prevA = clean.length >= 2 && clean[clean.length - 2].role === 'assistant' ? clean[clean.length - 2].content : '';
  const names = (await skills.find().toArray()).map(x => x.name);
  const r = await groqJSON([
    {
      role: 'system',
      content: 'You route messages for an AI assistant called Nabla AI. Decide if the user is asking the assistant to manage ITS OWN memory or skills (not asking a normal question or task). Return ONLY JSON {"intent":"...","arg":"...","name":"..."}. Intents: chat (DEFAULT for any normal question, task or when unsure), remember (user wants a fact remembered; arg = the fact), show_memory, forget_all (wipe ALL memory), forget_one (forget one remembered thing; arg = which), learn_skill (user describes a new permanent behaviour or skill; arg = description), teach_from_chat (turn this conversation into a skill), show_skills, delete_skill (name = skill name or description), improve_skill (name = skill, arg = what to improve), rollback_skill (name), enable_skill (name), evolve (tidy or merge skills), stats (how much has it learned). Existing skills: ' + JSON.stringify(names)
    },
    { role: 'user', content: JSON.stringify({ message: own, previous_assistant_reply: prevA.slice(0, 300) }) }
  ], 500);
  if (!r || typeof r.intent !== 'string' || r.intent === 'chat') return null;
  const arg = String(r.arg || '').trim().slice(0, 600);
  const name = String(r.name || '').trim().slice(0, 60);
  const ask = (text, run) => { pending.set(convId, { run, exp: Date.now() + 120000 }); return text; };

  switch (r.intent) {
    case 'remember': {
      const fact = arg.slice(0, 200);
      if (SECRET_LIKE.test(fact)) return '🔒 Passwords ya secrets main yaad nahi rakhta.';
      if (fact.length < 3 || isBad(fact)) return null;
      await memories.insertOne({ _id: crypto.randomUUID(), fact, type: 'fact', time: new Date(), auto: false });
      return '✅ Yaad kar liya: ' + fact;
    }
    case 'show_memory': {
      const mem = await memories.find().sort({ time: -1 }).limit(40).toArray();
      return mem.length ? mem.map(m => (m.type === 'lesson' ? '📘 ' : '• ') + m.fact).join('\n') : 'Abhi mujhe kuch yaad nahi hai.';
    }
    case 'forget_all':
      return ask('⚠️ Saari memory delete kar du? "haan" bolo ya "nahi".', async () => {
        await memories.deleteMany({});
        return '🗑️ Saari memory delete ho gayi.';
      });
    case 'forget_one': {
      const toks = tokens(arg);
      const mem = await memories.find().toArray();
      let best = null, bs = 0;
      for (const m of mem) {
        const sc = toks.filter(t => m.fact.toLowerCase().includes(t)).length;
        if (sc > bs) { best = m; bs = sc; }
      }
      if (!best) return 'Aisi koi baat mujhe yaad nahi mili.';
      return ask('⚠️ Yeh bhool jau? "' + best.fact + '" — "haan" ya "nahi".', async () => {
        await memories.deleteOne({ _id: best._id });
        return '🗑️ Bhool gaya.';
      });
    }
    case 'learn_skill': {
      const res = await skillFromDescription(arg || own);
      return res.error ? '⚠️ ' + res.error : '✅ Naya skill seekh liya: **' + res.sk.name + '**\nTriggers: ' + res.sk.triggers.join(', ');
    }
    case 'teach_from_chat': {
      const res = await skillFromChat(clean.slice(0, -1));
      return res.error ? '⚠️ ' + res.error : '✅ Is chat se skill ban gaya: **' + res.sk.name + '**\nTriggers: ' + res.sk.triggers.join(', ');
    }
    case 'show_skills': {
      const all = await skills.find().sort({ createdAt: -1 }).toArray();
      return all.length ? all.map(x => '• **' + x.name + '** v' + (x.version || 1) + (x.auto ? ' 🤖auto' : '') + (x.disabled ? ' ⛔band' : '') + ' | used ' + (x.uses || 0) + 'x | ' + x.triggers.join(', ')).join('\n') : 'Abhi koi skill nahi hai.';
    }
    case 'delete_skill': {
      const sk = await resolveSkill(name || arg);
      if (!sk) return 'Kaunsa skill hatana hai? Naam thoda aur saaf batao (ya "skills dikhao" bolo).';
      return ask('⚠️ Skill **' + sk.name + '** delete kar du? "haan" ya "nahi".', async () => {
        await skills.deleteOne({ _id: sk._id });
        return '🗑️ Skill **' + sk.name + '** delete ho gaya.';
      });
    }
    case 'improve_skill': {
      const sk = await resolveSkill(name);
      if (!sk) return 'Kaunsa skill improve karna hai? Naam batao.';
      if (arg.length < 5 || isBad(arg)) return 'Kya behtar karna hai, thoda detail me batao.';
      return (await refineSkill(sk, '', '', arg)) ? '🧠 Skill **' + sk.name + '** improve ho gaya.' : '⚠️ Improve nahi ho paya, dobara try karo.';
    }
    case 'rollback_skill': {
      const sk = await resolveSkill(name);
      if (!sk) return 'Kaunsa skill? Naam batao.';
      if (!sk.prev) return 'Is skill ka purana version nahi hai.';
      await skills.updateOne({ _id: sk._id }, { $set: { instructions: sk.prev, prev: sk.instructions, updatedAt: new Date() }, $inc: { version: 1 } });
      return '↩️ Skill **' + sk.name + '** ka purana version wapas aa gaya.';
    }
    case 'enable_skill': {
      const sk = await resolveSkill(name);
      if (!sk) return 'Kaunsa skill chalu karna hai? Naam batao.';
      await skills.updateOne({ _id: sk._id }, { $set: { disabled: false, score: 0 } });
      return '✅ Skill **' + sk.name + '** chalu ho gaya.';
    }
    case 'evolve': {
      const e = await evolveSkills(false);
      return e.note || ('🧹 ' + e.merged + ' merge, ' + e.removed + ' duplicate hataye.');
    }
    case 'stats': {
      const st = await statsObj();
      return '📊 **Nabla AI ne ab tak seekha**\nFacts: ' + st.facts + '\nLessons: ' + st.lessons + '\nSkills: ' + st.skills + ' (auto: ' + st.auto + ', band: ' + st.disabled + ')\nChats: ' + st.chats;
    }
    default:
      return null;
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
<div style="font-size:11px;color:#94a3b8;text-align:center">/help se commands dekho</div>
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
<input type="file" id="fileUpload" accept=".txt,.json,.js,.md,.csv,.py,.html,.css,.log,image/*" onchange="handleFile(event)">
<button class="ib" id="micBtn" onclick="startVoice()">🎤</button>
<input type="text" id="promptInput" placeholder="Message Nabla AI... (/help for commands)" onkeypress="if(event.key==='Enter')onSend()">
<button id="sendBtn" onclick="onSend()">Send</button>
</div>
</div>

<script>
var $ = function(id){ return document.getElementById(id); };
var token = ''; try { token = localStorage.getItem('nabla_token') || ''; } catch(e) {}
var mode = 'chat', projectId = '', attached = '', attachedImg = '', controller = null, busy = false, lastUsed = [];
try { projectId = localStorage.getItem('nabla_project') || ''; } catch(e) {}
var chatLog = [];
var convId = newId();
try {
  var saved = JSON.parse(localStorage.getItem('nabla_current'));
  if (saved && saved.id) { convId = saved.id; chatLog = saved.messages || []; }
} catch(e) {}

function newId(){ return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2); }
function persist(){ try { localStorage.setItem('nabla_current', JSON.stringify({ id: convId, messages: chatLog.slice(-60).map(function(m){ return { role: m.role, content: m.content }; }) })); } catch(e) {} }

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
  if (!chatLog.length) { addMsg('ai', 'Namaste! Main Nabla AI hoon. Aaj main aapki kya madad kar sakta hoon? (Seedha bolo, jaise \"ye yaad rakho...\" ya \"skills dikhao\")'); return; }
  chatLog.forEach(function(m){
    var shown = m.content;
    var i = shown.indexOf('\n\n[FILE CONTENT START]');
    if (i > -1) shown = shown.slice(0, i) + ' 📎';
    addMsg(m.role === 'user' ? 'user' : 'ai', shown);
  });
}
function toggleSidebar(){ $('sidebar').classList.toggle('open'); $('overlay').classList.toggle('open'); }
function newChat(){
  chatLog = []; lastUsed = []; convId = newId(); persist(); renderHistory();
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
function loadImage(f){
  var r = new FileReader();
  r.onload = function(ev){
    var img = new Image();
    img.onload = function(){
      var k = Math.min(1, 1024 / Math.max(img.width, img.height));
      var c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      var url = c.toDataURL('image/jpeg', 0.7);
      if (url.length > 1500000) { addMsg('ai', '⚠️ Image bahut badi hai.'); return; }
      attachedImg = url; $('promptInput').value += ' [Image: ' + f.name + '] ';
    };
    img.onerror = function(){ addMsg('ai', '⚠️ Image read nahi hui.'); };
    img.src = ev.target.result;
  };
  r.readAsDataURL(f);
}
function handleFile(e){
  var f = e.target.files[0]; if (!f) return;
  var isImg = /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);
  var isTxt = /\.(txt|json|js|md|csv|py|html|css|log)$/i.test(f.name);
  if (isImg) { loadImage(f); e.target.value = ''; return; }
  if (!isTxt) { addMsg('ai', '⚠️ Sirf image ya text/code file (.txt .json .js .md .csv .py .html .css .log) support hoti hai.'); e.target.value = ''; return; }
  if (f.size > 300000) { addMsg('ai', '⚠️ File bahut badi hai (max 300KB).'); e.target.value = ''; return; }
  var r = new FileReader();
  r.onload = function(ev){ attached = ev.target.result; $('promptInput').value += ' [Attached: ' + f.name + '] '; e.target.value = ''; };
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
    convId = c._id; chatLog = c.messages || []; lastUsed = []; persist(); renderHistory(); toggleSidebar();
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
      addMsg('ai', '**Seedha bolo, commands ki zaroorat nahi:**\n"ye yaad rakho ki main Delhi me rehta hoon"\n"meri memory dikhao" / "sab bhool jao"\n"email wala skill hata do"\n"naya skill seekho: har jawab me ek example do"\n"is chat se skill bana lo"\n"skills dikhao" / "skills tidy karo" / "kitna seekha?"\n\nMain khud bhi seekhta hoon: jab tum "galat hai" ya "perfect" bolte ho to wo bhi samajh leta hoon.\n\n**Slash commands (optional)**\n/remember <fact>\n/memory - facts + lessons\n/forget - saari memory delete\n/learn <description> - naya skill banwao\n/teach - is chat se skill banao\n/evolve - skills ko tidy/merge karo\n/skills - skills list\n/improve <skill> <feedback> - skill behtar karo\n/rollback <skill> - purana version wapas\n/enable <skill> - band skill chalu\n/unlearn <skill> - delete\n/stats - kitna seekha\n\nMain khud bhi naye skills banata hoon aur 👍/👎 se improve hota hoon.');
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
    } else if (cmd === '/teach') {
      if (chatLog.length < 2) return addMsg('ai', 'Pehle thodi chat karo, phir /teach.');
      var d3 = addMsg('ai', '🧠 Is chat se skill bana raha hoon...');
      var tm = chatLog.slice(-8).map(function(m){ return { role: m.role, content: m.content.split('\n\n[FILE CONTENT START]')[0] }; });
      var r7 = await call('/api/skills/from-chat', 'POST', { messages: tm });
      d3.innerHTML = fmt(r7.ok ? '✅ Skill ban gaya: **' + r7.j.name + '**\nTriggers: ' + r7.j.triggers.join(', ') : '⚠️ ' + (r7.j.error || 'Fail'));
    } else if (cmd === '/evolve') {
      var d4 = addMsg('ai', '🧹 Skills tidy kar raha hoon...');
      var r8 = await call('/api/evolve', 'POST');
      d4.innerHTML = fmt(r8.ok ? (r8.j.note || ('✅ ' + r8.j.merged + ' merge, ' + r8.j.removed + ' duplicate hataye.')) : '⚠️ ' + (r8.j.error || 'Fail'));
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
      addMsg('ai', '📊 **Nabla AI ne ab tak seekha**\nFacts: ' + st.facts + '\nLessons: ' + st.lessons + '\nSkills: ' + st.skills + ' (auto: ' + st.auto + ', band: ' + st.disabled + ')\nChats: ' + st.chats);
    } else {
      addMsg('ai', 'Unknown command. /help dekho.');
    }
  } catch(e) { if (e.message !== 'auth') addMsg('ai', '⚠️ Command fail hua.'); }
}

// ---------- sending ----------
function onSend(){ if (busy) { if (controller) controller.abort(); } else send(false); }
function regenerate(){
  if (busy) return;
  while (chatLog.length && chatLog[chatLog.length - 1].role === 'assistant') chatLog.pop();
  if (!chatLog.length) return;
  renderHistory(); send(true);
}
async function send(regen){
  var input = $('promptInput');
  if (!regen) {
    var text = input.value.trim();
    if (!text && !attached && !attachedImg) return;
    if (text.charAt(0) === '/') { input.value = ''; return runCommand(text); }
    var content = text || (attachedImg ? 'Is image me kya hai?' : '');
    if (attached) content += '\n\n[FILE CONTENT START]\n' + attached.slice(0, 12000) + '\n[FILE CONTENT END]';
    var umsg = { role:'user', content: content };
    if (attachedImg) umsg.img = attachedImg;
    chatLog.push(umsg);
    var ud = addMsg('user', text || (attachedImg ? '🖼️ image' : '📎 file'));
    if (attachedImg) {
      var im = document.createElement('img'); im.src = attachedImg;
      im.style.cssText = 'display:block;max-width:160px;border-radius:6px;margin-top:6px';
      ud.appendChild(im);
    }
    input.value = ''; attached = ''; attachedImg = '';
  }
  busy = true; $('sendBtn').textContent = 'Stop'; $('sendBtn').classList.add('stop');
  var div = addMsg('ai', '...');
  var full = '', used = [];
  var lastUser = chatLog[chatLog.length - 1].content;
  var promptText = lastUser.split('\n\n[FILE CONTENT START]')[0];
  controller = new AbortController();
  try {
    var res = await api('/api/generate', {
      method:'POST', signal: controller.signal,
      body: JSON.stringify({
        convId: convId, mode: mode, projectId: projectId, prevSkills: lastUsed,
        messages: chatLog.map(function(m, i){
          var o = { role: m.role, content: m.content };
          if (m.img && i === chatLog.length - 1) o.image = m.img;
          return o;
        })
      })
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
    chatLog.push({ role:'assistant', content: full });
    div.innerHTML = fmt(full);
    addActions(div, full, { prompt: promptText, reply: full, skills: used });
    lastUsed = used;
    persist(); loadChats();
    setTimeout(checkNotices, 6000);
    setTimeout(checkNotices, 14000);
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
  const r = await skillFromDescription(String(req.body.description || '').trim().slice(0, 600));
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json({ name: r.sk.name, triggers: r.sk.triggers });
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

app.post('/api/skills/from-chat', auth, needDb, rateLimit('teach', 6, 60000), async (req, res) => {
  const r = await skillFromChat(req.body.messages);
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json({ name: r.sk.name, triggers: r.sk.triggers });
});

app.post('/api/evolve', auth, needDb, rateLimit('evolve', 3, 60000), async (req, res) => {
  res.json(await evolveSkills(false));
});

app.get('/api/stats', auth, async (req, res) => {
  if (!dbReady()) return res.json({ facts: 0, lessons: 0, skills: 0, auto: 0, disabled: 0, chats: 0 });
  res.json(await statsObj());
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
    const { improved, paused } = await applyNegative(used, prompt, reply, note);
    msg = improved.length ? '🧠 Skill improve kiya: ' + improved.join(', ') : '📝 Feedback note kar liya.';
    if (paused.length) msg += ' ⛔ Band kiya (bahut 👎): ' + paused.join(', ') + ' (bolo "' + paused[0] + ' skill chalu karo")';
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
  const part = raw.slice(-100);
  part.forEach((m, i) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return;
    const e = { role: m.role, content: m.content.slice(0, 20000) };
    if (i === part.length - 1 && m.role === 'user' && typeof m.image === 'string' &&
        m.image.length <= 1600000 && IMG_RE.test(m.image)) e.image = m.image;
    out.push(e);
  });
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

  // ---- natural-language control of memory & skills (no slash commands needed) ----
  const intentText = await handleIntent(own, clean, convId, !!clean[clean.length - 1].image)
    .catch(e => { console.log('Intent error:', e.message); return null; });
  if (intentText !== null) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Skills-Used', '');
    res.write(intentText);
    res.end();
    saveChat(convId, clean, mode, intentText);
    return;
  }

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
      hit = all.filter(s => s.triggers.some(t => matchesTrigger(lowered, t))).slice(0, 3);
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
    const lastMsg = clean[clean.length - 1];
    const img = lastMsg.image || null;
    const aiMsgs = trimForAI(clean).map(m => (m === lastMsg && img)
      ? { role: 'user', content: [{ type: 'text', text: m.content }, { type: 'image_url', image_url: { url: img } }] }
      : { role: m.role, content: m.content });
    const upstream = await groqFetch({
      messages: [{ role: 'system', content: sys }, ...aiMsgs],
      stream: true,
      max_tokens: 2048
    }, ac.signal, img ? [VISION_MODEL] : null);

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
      const hadImg = !!clean[clean.length - 1].image;
      const msg = error.status === 429 ? 'AI limit reached. Thodi der baad try karo.'
        : hadImg ? 'Image wala model kaam nahi kar raha. GROQ_VISION_MODEL check karo.'
        : 'Error generating response.';
      return res.status(code).json({ error: msg });
    }
    res.write('\n\n⚠️ Connection toot gaya.');
    res.end();
  }

  // ---- after reply: save chat + background self-learning ----
  if (full && dbReady()) {
    saveChat(convId, clean, mode, full);
    const prev = clean.length >= 2 && clean[clean.length - 2].role === 'assistant' ? clean[clean.length - 2].content : '';
    const prevUser = clean.length >= 3 && clean[clean.length - 3].role === 'user' ? clean[clean.length - 3].content : '';
    const prevSkills = (Array.isArray(req.body.prevSkills) ? req.body.prevSkills : [])
      .map(x => String(x).toLowerCase()).filter(validId).slice(0, 5);
    learnFromExchange(own, prev, prevSkills, prevUser).catch(e => console.log('Learn error:', e.message));
  }
});

// ================= DAILY SELF-TIDY =================
setInterval(() => {
  if (AUTO_SKILL && dbReady()) evolveSkills(true).catch(e => console.log('Evolve error:', e.message));
}, 24 * 3600 * 1000);

// ================= KEEP RENDER AWAKE =================
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {});
  }
}, 14 * 60 * 1000);

app.get('/health', (req, res) => res.json({ ok: true, db: dbReady() }));

process.on('unhandledRejection', e => console.log('Unhandled:', e && e.message));
process.on('SIGTERM', () => { console.log('Shutting down'); process.exit(0); });

app.listen(port, () => console.log('🚀 Nabla AI running on port ' + port));
