require('dotenv').config();
const express = require('express');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Clean the key: removes spaces, quotes, line breaks
function getKey() {
  return (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, '');
}

const DB_FILE = './database.json';
function saveToDatabase(prompt, response) {
  try {
    let data = [];
    if (fs.existsSync(DB_FILE)) {
      try { data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { data = []; }
    }
    data.push({ time: new Date().toISOString(), prompt, response });
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('⚠️ [DB] Save failed:', e.message);
  }
}

const badPatterns = [/ignore previous instructions/i, /print system prompt/i, /hack/i];
function promptGuard(req, res, next) {
  const prompt = (req.body && req.body.prompt) || '';
  if (badPatterns.some((p) => p.test(prompt))) {
    console.log('🚨 [SECURITY] Attack blocked:', prompt);
    return res.status(403).json({ error: 'Blocked: Prompt injection detected!' });
  }
  next();
}

// Health check: open /health in browser
app.get('/health', (req, res) => {
  const key = getKey();
  res.json({
    hasKey: !!key,
    keyLength: key.length,
    keyStartsWith: key ? key.slice(0, 4) : null, // Groq keys start with "gsk_"
    node: process.version,
  });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Groq AI Chat</title>
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: Arial; padding: 20px; }
    .container { max-width: 500px; margin: auto; background: #1e293b; padding: 20px; border-radius: 10px; }
    h1 { color: #f59e0b; text-align: center; }
    input { width: 80%; padding: 10px; border-radius: 5px; border: none; margin-bottom: 10px; }
    button { padding: 10px 15px; background: #f59e0b; border: none; border-radius: 5px; font-weight: bold; cursor: pointer; }
    #output { margin-top: 20px; padding: 15px; background: #0f172a; border-radius: 5px; min-height: 50px; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚡ Groq AI (Free & Fast)</h1>
    <input type="text" id="promptInput" placeholder="Ask the AI something...">
    <button onclick="sendPrompt()">Send</button>
    <div id="output">AI response will appear here...</div>
  </div>
  <script>
    async function sendPrompt() {
      const prompt = document.getElementById('promptInput').value;
      const output = document.getElementById('output');
      if (!prompt) return alert("Please type something!");
      output.innerText = "Thinking...";
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: prompt })
        });
        const data = await res.json();
        if (data.error) {
          output.innerText = "❌ " + data.error;
        } else if (data.isFallback) {
          output.innerText = "⚠️ " + data.reply + "\\n\\nReason: " + (data.debug || "unknown");
        } else {
          output.innerText = "✅ " + data.reply;
        }
      } catch (err) {
        output.innerText = "❌ Error connecting to server.";
      }
    }
  </script>
</body>
</html>`);
});

app.post('/api/generate', promptGuard, async (req, res) => {
  const userPrompt = req.body.prompt;
  let aiReply = null;
  let debug = null;
  const key = getKey();

  if (!key) {
    debug = 'GROQ_API_KEY is missing on the server (set it in Render > Environment).';
    console.log('⚠️ [GROQ]', debug);
  } else if (typeof fetch !== 'function') {
    debug = 'Node version too old. Set NODE_VERSION=20 in Render > Environment.';
    console.log('⚠️ [GROQ]', debug);
  } else {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        aiReply = data.choices[0].message.content;
      } else {
        const errorText = await response.text();
        debug = `Groq status ${response.status}: ${errorText.slice(0, 300)}`;
        console.log('⚠️ [GROQ] API failed.', debug);
      }
    } catch (error) {
      debug = 'Network error: ' + error.message;
      console.log('⚠️ [GROQ]', debug);
    }
  }

  let isFallback = false;
  if (!aiReply) {
    aiReply = "I'm experiencing high traffic right now. Please try again soon!";
    isFallback = true;
  }

  saveToDatabase(userPrompt, aiReply);
  res.json({ reply: aiReply, isFallback, debug });
});

app.listen(port, () => {
  console.log(`🚀 Groq AI Server running on port ${port}`);
});
