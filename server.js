require('dotenv').config();
const dns = require('dns');
dns.setServers(['1.1.1.1', '1.0.0.1']);

const express = require('express');
const { MongoClient } = require('mongodb');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// --- 1. DATABASE SETUP (MongoDB) ---
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
} else {
  console.log('⚠️ No MONGODB_URI found. Data will not save.');
}

// --- 2. SECURITY (Prompt Guard & Auth) ---
function getKey() {
  return (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, '');
}

const badPatterns = [/ignore previous instructions/i, /print system prompt/i, /hack/i];
function promptGuard(req, res, next) {
  const messages = req.body.messages || [];
  const lastMsg = messages[messages.length - 1]?.content || "";
  
  if (badPatterns.some((p) => p.test(lastMsg))) {
    console.log('🚨 [SECURITY] Attack blocked:', lastMsg);
    return res.status(403).json({ error: 'Blocked: Prompt injection detected!' });
  }
  next();
}

// --- 3. FRONTEND UI (Login + Chat Memory) ---
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hermes AI</title>
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: Arial; margin: 0; padding: 20px; display: flex; justify-content: center; height: 100vh; box-sizing: border-box; }
    .container { width: 100%; max-width: 500px; background: #1e293b; border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; }
    
    /* Login Screen */
    #login-screen { padding: 40px; text-align: center; display: flex; flex-direction: column; justify-content: center; height: 100%; }
    h1 { color: #f59e0b; margin-top: 0; }
    input[type="password"] { padding: 12px; border-radius: 5px; border: none; margin-bottom: 15px; width: 100%; box-sizing: border-box; }
    button { padding: 12px; background: #f59e0b; color: #000; border: none; border-radius: 5px; font-weight: bold; cursor: pointer; width: 100%; }
    
    /* Chat Screen */
    #chat-screen { display: none; flex-direction: column; height: 100%; }
    #chat-box { flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
    .message { padding: 10px; border-radius: 8px; max-width: 80%; word-wrap: break-word; }
    .user { background: #f59e0b; color: #000; align-self: flex-end; }
    .ai { background: #334155; color: #fff; align-self: flex-start; }
    .input-area { display: flex; padding: 10px; background: #0f172a; gap: 10px; }
    .input-area input { flex: 1; padding: 10px; border-radius: 5px; border: none; margin-bottom: 0; }
    .input-area button { width: auto; }
  </style>
</head>
<body>
  <div class="container">
    
    <!-- Login UI -->
    <div id="login-screen">
      <h1>🔒 Hermes AI</h1>
      <p style="color:#94a3b8; font-size: 14px;">Enter the password to access the AI.</p>
      <input type="password" id="passInput" placeholder="Enter Password...">
      <button onclick="login()">Unlock</button>
    </div>

    <!-- Chat UI -->
    <div id="chat-screen">
      <div style="padding: 15px; background: #0f172a; text-align: center; font-weight: bold; color: #f59e0b;">⚡ Hermes Chat</div>
      <div id="chat-box">
        <div class="message ai">Hello! I am your AI. I remember our chat. What's your name?</div>
      </div>
      <div class="input-area">
        <input type="text" id="promptInput" placeholder="Type a message..." onkeypress="if(event.key === 'Enter') sendPrompt()">
        <button onclick="sendPrompt()">Send</button>
      </div>
    </div>

  </div>
  
  <script>
    // Check if user already logged in
    if (localStorage.getItem('hermes_pass')) {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('chat-screen').style.display = 'flex';
    }

    let chatHistory = [];

    function login() {
      const pass = document.getElementById('passInput').value;
      if (pass === "12345") { // CHANGE THIS PASSWORD if you want!
        localStorage.setItem('hermes_pass', pass);
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('chat-screen').style.display = 'flex';
      } else {
        alert("Wrong password!");
      }
    }

    async function sendPrompt() {
      const input = document.getElementById('promptInput');
      const prompt = input.value;
      const chatBox = document.getElementById('chat-box');
      if (!prompt) return;
      
      // Add user msg to UI
      chatBox.innerHTML += '<div class="message user">' + prompt + '</div>';
      input.value = "";
      chatBox.scrollTop = chatBox.scrollHeight;
      chatHistory.push({ role: "user", content: prompt });

      // Thinking...
      const thinkId = "think-" + Date.now();
      chatBox.innerHTML += '<div class="message ai" id="' + thinkId + '">Thinking...</div>';
      chatBox.scrollTop = chatBox.scrollHeight;
      
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-app-password': localStorage.getItem('hermes_pass') // Send password
          },
          body: JSON.stringify({ messages: chatHistory })
        });
        const data = await res.json();
        document.getElementById(thinkId).remove();

        if (data.error) {
          chatBox.innerHTML += '<div class="message ai" style="color:red;">❌ ' + data.error + '</div>';
        } else {
          chatBox.innerHTML += '<div class="message ai">' + data.reply + '</div>';
          chatHistory.push({ role: "assistant", content: data.reply });
        }
      } catch (err) {
        document.getElementById(thinkId).innerText = "❌ Error.";
      }
      chatBox.scrollTop = chatBox.scrollHeight;
    }
  </script>
</body>
</html>`);
});

// --- 4. THE AI ENDPOINT ---
app.post('/api/generate', (req, res, next) => {
  // Check Password (Auth)
  if (req.headers['x-app-password'] !== "12345") { 
    return res.status(401).json({ error: 'Unauthorized. Wrong Password.' });
  }
  next();
}, promptGuard, async (req, res) => {
  
  const messages = req.body.messages; 
  const userPrompt = messages[messages.length - 1].content; 
  const key = getKey();
  let aiReply = null;
  let debug = null;

  if (!key) {
    debug = 'GROQ_API_KEY is missing.';
  } else {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b', 
          messages: messages // Send the whole history!
        }),
      });

      if (response.ok) {
        const data = await response.json();
        aiReply = data.choices[0].message.content;
      } else {
        debug = `Groq status ${response.status}`;
      }
    } catch (error) {
      debug = 'Network error: ' + error.message;
    }
  }

  let isFallback = false;
  if (!aiReply) {
    aiReply = "I'm experiencing high traffic. Please try again!";
    isFallback = true;
  }

  // Save to MongoDB if connected
  if (chatsCollection) {
    chatsCollection.insertOne({ time: new Date(), prompt: userPrompt, reply: aiReply })
      .catch(err => console.log('DB Save Error:', err));
  }

  res.json({ reply: aiReply, isFallback, debug });
});

app.listen(port, () => {
  console.log(`🚀 Master Server running on port ${port}`);
});
