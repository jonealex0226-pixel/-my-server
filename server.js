require('dotenv').config();
const dns = require('dns');
dns.setServers(['1.1.1.1', '1.0.0.1']); // Cloudflare DNS

const express = require('express');
const { MongoClient } = require('mongodb');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// --- 1. DATABASE SETUP ---
const uri = process.env.MONGODB_URI;
let db, chatsCollection;

if (uri) {
  const client = new MongoClient(uri);
  client.connect()
    .then(() => {
      db = client.db('hermes_ai');
      chatsCollection = db.collection('chats');
      console.log('✅ Connected to MongoDB');
    })
    .catch(err => console.log('❌ MongoDB Error:', err.message));
}

// --- 2. SECURITY & PERSONALITY ---
function getKey() {
  return (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, '');
}

const systemPrompt = {
  role: "system", 
  content: "You are Hermes, a helpful, witty AI assistant. You must always reply in natural Hinglish (a mix of Hindi and English). Keep your answers concise, engaging, and friendly."
};

const badPatterns = [/ignore previous instructions/i, /print system prompt/i, /hack/i];
function promptGuard(req, res, next) {
  const messages = req.body.messages || [];
  const lastMsg = messages[messages.length - 1]?.content || "";
  
  if (badPatterns.some((p) => p.test(lastMsg))) {
    return res.status(403).json({ error: 'Blocked: Prompt injection detected!' });
  }
  next();
}

// --- 3. FRONTEND UI (Streaming + Secure Password) ---
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hermes AI</title>
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: Arial; margin: 0; padding: 20px; display: flex; justify-content: center; height: 100vh; box-sizing: border-box; }
    .container { width: 100%; max-width: 500px; background: #1e293b; border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    
    /* Login Screen */
    #login-screen { padding: 40px; text-align: center; display: flex; flex-direction: column; justify-content: center; height: 100%; }
    h1 { color: #f59e0b; margin-top: 0; }
    input[type="password"] { padding: 12px; border-radius: 5px; border: none; margin-bottom: 15px; width: 100%; box-sizing: border-box; }
    button { padding: 12px; background: #f59e0b; color: #000; border: none; border-radius: 5px; font-weight: bold; cursor: pointer; width: 100%; }
    
    /* Chat Screen */
    #chat-screen { display: none; flex-direction: column; height: 100%; }
    #chat-box { flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
    .message { padding: 10px; border-radius: 8px; max-width: 80%; word-wrap: break-word; line-height: 1.4; }
    .user { background: #f59e0b; color: #000; align-self: flex-end; border-bottom-right-radius: 0; }
    .ai { background: #334155; color: #fff; align-self: flex-start; border-bottom-left-radius: 0; }
    .input-area { display: flex; padding: 10px; background: #0f172a; gap: 10px; }
    .input-area input { flex: 1; padding: 10px; border-radius: 5px; border: none; margin-bottom: 0; }
    .input-area button { width: auto; padding: 10px 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div id="login-screen">
      <h1>🔒 Hermes AI</h1>
      <p style="color:#94a3b8; font-size: 14px;">Enter Password to unlock.</p>
      <input type="password" id="passInput" placeholder="Enter Password...">
      <button onclick="login()">Unlock</button>
    </div>

    <div id="chat-screen">
      <div style="padding: 15px; background: #0f172a; text-align: center; font-weight: bold; color: #f59e0b;">⚡ Hermes (Hinglish)</div>
      <div id="chat-box">
        <div class="message ai">Namaste! Main Hermes hoon. Aaj main aapki kya madad kar sakta hoon?</div>
      </div>
      <div class="input-area">
        <input type="text" id="promptInput" placeholder="Type a message..." onkeypress="if(event.key === 'Enter') sendPrompt()">
        <button onclick="sendPrompt()" id="sendBtn">Send</button>
      </div>
    </div>
  </div>
  
  <script>
    const SECURE_PASSWORD = "NablaAI@99"; // 👈 NEW PASSWORD HERE

    if (localStorage.getItem('hermes_pass') === SECURE_PASSWORD) {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('chat-screen').style.display = 'flex';
    }

    let chatHistory = [];

    function login() {
      const pass = document.getElementById('passInput').value;
      if (pass === SECURE_PASSWORD) {
        localStorage.setItem('hermes_pass', pass);
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('chat-screen').style.display = 'flex';
      } else {
        alert("Galat password! (Wrong password)");
      }
    }

    async function sendPrompt() {
      const input = document.getElementById('promptInput');
      const prompt = input.value;
      const chatBox = document.getElementById('chat-box');
      const sendBtn = document.getElementById('sendBtn');
      
      if (!prompt) return;
      
      chatBox.innerHTML += '<div class="message user">' + prompt + '</div>';
      input.value = "";
      sendBtn.disabled = true;
      chatBox.scrollTop = chatBox.scrollHeight;
      chatHistory.push({ role: "user", content: prompt });

      const aiMsgId = "ai-" + Date.now();
      chatBox.innerHTML += '<div class="message ai" id="' + aiMsgId + '">...</div>';
      const aiMsgDiv = document.getElementById(aiMsgId);
      let fullReply = "";

      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-app-password': localStorage.getItem('hermes_pass')
          },
          body: JSON.stringify({ messages: chatHistory })
        });
        
        if (!res.ok) throw new Error("Network error");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          fullReply += chunk;
          aiMsgDiv.innerText = fullReply;
          chatBox.scrollTop = chatBox.scrollHeight;
        }
        
        chatHistory.push({ role: "assistant", content: fullReply });

      } catch (err) {
        aiMsgDiv.innerText = "❌ Error connecting to AI.";
      }
      sendBtn.disabled = false;
    }
  </script>
</body>
</html>`);
});

// --- 4. THE AI ENDPOINT (Streaming + DB Save) ---
app.post('/api/generate', (req, res, next) => {
  if (req.headers['x-app-password'] !== "NablaAI@99") { // 👈 NEW PASSWORD HERE
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}, promptGuard, async (req, res) => {
  
  const messages = req.body.messages; 
  const userPrompt = messages[messages.length - 1].content; 
  const key = getKey();

  if (!key) return res.send("API key missing.");

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b', 
        messages: [systemPrompt, ...messages], 
        stream: true 
      }),
    });

    if (!response.ok) {
       return res.send("AI limit reached. Please try again.");
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

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
            if (content) {
              fullReply += content;
              res.write(content); 
            }
          } catch (e) {}
        }
      }
    }
    res.end();

    if (chatsCollection && fullReply) {
      chatsCollection.insertOne({ time: new Date(), prompt: userPrompt, reply: fullReply })
        .catch(err => console.log('DB Save Error:', err));
    }

  } catch (error) {
    console.log("Error:", error.message);
    res.send("Error generating response.");
  }
});

// --- 5. KEEP RENDER AWAKE ---
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {});
  }
}, 14 * 60 * 1000);

app.get('/health', (req, res) => res.send('OK'));

app.listen(port, () => {
  console.log(`🚀 Master Server running on port ${port}`);
});
