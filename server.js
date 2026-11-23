require('dotenv').config();
const dns = require('dns');
dns.setServers(['1.1.1.1', '1.0.0.1']); 

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

// --- 2. SECURITY & AI PERSONALITY ---
function getKey() {
  return (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, '');
}

const prompts = {
  chat: "You are Nabla AI, a helpful, witty AI assistant. You must always reply in natural Hinglish (a mix of Hindi and English). Keep your answers concise, engaging, and friendly. Use markdown for formatting.",
  work: "You are Nabla AI in WORK MODE. You are a highly structured, analytical assistant. Provide detailed, step-by-step answers in professional English using markdown formatting (bullet points, bold text)."
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

// --- 3. FRONTEND UI ---
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nabla AI</title>
  <style>
    * { box-sizing: border-box; }
    body { background: #0f172a; color: #f8fafc; font-family: Arial; margin: 0; display: flex; height: 100vh; overflow: hidden; }
    
    /* Boot Animation (Pure CSS fade-out so it NEVER gets stuck) */
    #boot-screen { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #0f172a; z-index: 9999; display: flex; flex-direction: column; justify-content: center; align-items: center; animation: fadeOut 0.5s ease 1.5s forwards; }
    .boot-logo { font-size: 40px; font-weight: bold; color: #f59e0b; animation: pulse 1.5s infinite; text-shadow: 0 0 20px rgba(245, 158, 11, 0.5); }
    .boot-sub { color: #94a3b8; margin-top: 10px; font-size: 14px; letter-spacing: 2px; }
    @keyframes pulse { 0% { transform: scale(1); opacity: 0.7; } 50% { transform: scale(1.05); opacity: 1; } 100% { transform: scale(1); opacity: 0.7; } }
    @keyframes fadeOut { to { opacity: 0; visibility: hidden; } }

    /* Login Screen */
    #login-screen { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #0f172a; z-index: 9000; display: none; flex-direction: column; justify-content: center; align-items: center; }
    .login-box { background: #1e293b; padding: 30px; border-radius: 10px; text-align: center; border: 1px solid #334155; }
    .login-box input { padding: 12px; border-radius: 5px; border: none; margin-bottom: 15px; width: 100%; font-size: 16px; }
    .login-box button { padding: 12px; background: #f59e0b; color: #000; border: none; border-radius: 5px; font-weight: bold; cursor: pointer; width: 100%; font-size: 16px; }

    /* Sidebar */
    #sidebar { width: 250px; background: #1e293b; position: fixed; height: 100%; left: -250px; transition: 0.3s; z-index: 100; padding: 20px; border-right: 1px solid #334155; display: flex; flex-direction: column; gap: 15px; }
    #sidebar.open { left: 0; }
    .sidebar-btn { background: #334155; color: white; padding: 12px; border: none; border-radius: 5px; cursor: pointer; text-align: left; font-size: 15px; }
    .sidebar-btn:hover { background: #475569; }
    .mode-toggle { display: flex; background: #0f172a; border-radius: 5px; padding: 4px; margin-top: auto; }
    .mode-btn { flex: 1; padding: 8px; border: none; background: transparent; color: #94a3b8; cursor: pointer; border-radius: 3px; font-weight: bold; }
    .mode-btn.active { background: #f59e0b; color: #000; }
    
    /* Overlay */
    #overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: none; z-index: 99; }
    #overlay.open { display: block; }

    /* Main App */
    .app-container { flex: 1; display: flex; flex-direction: column; height: 100%; width: 100%; max-width: 600px; margin: 0 auto; }
    
    /* Header */
    .header { padding: 15px; background: #1e293b; display: flex; align-items: center; border-bottom: 1px solid #334155; }
    .menu-btn { background: none; border: none; color: white; font-size: 24px; cursor: pointer; margin-right: 15px; }
    .header-title { font-weight: bold; color: #f59e0b; flex: 1; text-align: center; padding-right: 30px;}

    /* Chat Area */
    #chat-box { flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
    .message { padding: 12px; border-radius: 8px; max-width: 85%; word-wrap: break-word; line-height: 1.5; font-size: 15px; }
    .user { background: #f59e0b; color: #000; align-self: flex-end; border-bottom-right-radius: 0; }
    .ai { background: #1e293b; color: #fff; align-self: flex-start; border-bottom-left-radius: 0; border: 1px solid #334155; }
    
    /* Markdown Formatting inside AI messages */
    .ai b, .ai strong { color: #f59e0b; }
    .ai ul, .ai ol { margin: 5px 0; padding-left: 20px; }
    
    /* Input Area */
    .input-area { display: flex; padding: 10px; background: #1e293b; gap: 8px; align-items: center; border-top: 1px solid #334155; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
    .icon-btn { background: #334155; color: white; border: none; border-radius: 50%; width: 40px; height: 40px; font-size: 18px; display: flex; justify-content: center; align-items: center; cursor: pointer; flex-shrink: 0; }
    .icon-btn.recording { background: #ef4444; animation: mic-pulse 1s infinite; }
    .input-area input[type="text"] { flex: 1; padding: 12px; border-radius: 20px; border: none; background: #0f172a; color: white; font-size: 16px; min-width: 0; }
    .send-btn { background: #f59e0b; color: #000; padding: 10px 15px; border-radius: 20px; border: none; font-weight: bold; cursor: pointer; flex-shrink: 0; }
    
    @keyframes mic-pulse { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }
    #fileUpload { display: none; }
  </style>
</head>
<body>
  <!-- Boot Animation -->
  <div id="boot-screen">
    <div class="boot-logo">Nabla AI</div>
    <div class="boot-sub">SYSTEM INITIALIZING...</div>
  </div>

  <!-- Login Screen (Replaces the annoying popup) -->
  <div id="login-screen">
    <div class="login-box">
      <h2 style="color: #f59e0b;">🔒 Access Required</h2>
      <input type="password" id="loginPass" placeholder="Enter Password...">
      <button onclick="checkLogin()">Unlock</button>
      <p id="loginError" style="color: #ef4444; display: none; margin-top: 10px;">Wrong Password!</p>
    </div>
  </div>

  <!-- Sidebar -->
  <div id="sidebar">
    <h2 style="color: #f59e0b; margin-top: 0; text-align: center;">Nabla AI</h2>
    <button class="sidebar-btn" onclick="newChat()">➕ New Chat</button>
    <button class="sidebar-btn" onclick="alert('Projects coming soon!')">📁 Projects</button>
    
    <div class="mode-toggle">
      <button class="mode-btn active" id="btn-chat" onclick="setMode('chat')">Chat</button>
      <button class="mode-btn" id="btn-work" onclick="setMode('work')">Work</button>
    </div>
  </div>
  
  <div id="overlay" onclick="toggleSidebar()"></div>

  <!-- Main App -->
  <div class="app-container">
    <div class="header">
      <button class="menu-btn" onclick="toggleSidebar()">☰</button>
      <div class="header-title" id="header-title">⚡ Nabla AI (Hinglish)</div>
    </div>

    <div id="chat-box"></div>

    <div class="input-area">
      <button class="icon-btn" onclick="document.getElementById('fileUpload').click()">+</button>
      <input type="file" id="fileUpload" accept=".txt,.json,.js,.md,.csv" onchange="handleFile(event)">
      
      <button class="icon-btn" id="micBtn" onclick="startVoice()">🎤</button>
      
      <input type="text" id="promptInput" placeholder="Message Nabla AI..." onkeypress="if(event.key === 'Enter') sendPrompt()">
      <button class="send-btn" onclick="sendPrompt()" id="sendBtn">Send</button>
    </div>
  </div>
  
  <script>
    // --- BOOT & LOGIN LOGIC ---
    const SECURE_PASSWORD = "NablaAI@99";
    let savedPass = null;

    try { savedPass = localStorage.getItem('nabla_pass'); } catch(e) { console.log("LocalStorage blocked"); }

    window.addEventListener('DOMContentLoaded', () => {
      // Check Auth
      if (savedPass !== SECURE_PASSWORD) {
        document.getElementById('login-screen').style.display = 'flex';
      }
      
      // Force remove boot screen after 2 seconds (JS Fallback)
      setTimeout(() => {
        const boot = document.getElementById('boot-screen');
        if (boot) boot.remove();
      }, 2000);
    });

    function checkLogin() {
      const pass = document.getElementById('loginPass').value;
      if (pass === SECURE_PASSWORD) {
        try { localStorage.setItem('nabla_pass', pass); } catch(e) {}
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('boot-screen').remove(); // Force hide boot screen
      } else {
        document.getElementById('loginError').style.display = 'block';
      }
    }

    // --- UI & HISTORY LOGIC ---
    let currentMode = 'chat';
    let attachedFileText = "";
    let chatHistory = [];
    
    try {
      chatHistory = JSON.parse(localStorage.getItem('nabla_history')) || [];
    } catch(e) { chatHistory = []; }

    const chatBox = document.getElementById('chat-box');

    function formatText(text) {
      if (!text) return "";
      try {
        return String(text)
          .replace(/\\*\\*(.*?)\\*\\*/g, '<b>$1</b>') 
          .replace(/\\*(.*?)\\*/g, '<i>$1</i>')     
          .replace(/\\n/g, '<br>');                
      } catch(e) { return text; }
    }

    function renderHistory() {
      chatBox.innerHTML = ""; 
      if (chatHistory.length === 0) {
        chatBox.innerHTML = '<div class="message ai">Namaste! Main Nabla AI hoon. Aaj main aapki kya madad kar sakta hoon?</div>';
      } else {
        chatHistory.forEach(msg => {
          let className = msg.role === 'user' ? 'user' : 'ai';
          chatBox.innerHTML += '<div class="message ' + className + '">' + formatText(msg.content) + '</div>';
        });
      }
      chatBox.scrollTop = chatBox.scrollHeight;
    }
    renderHistory();

    function toggleSidebar() {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('overlay').classList.toggle('open');
    }

    function newChat() {
      chatHistory = [];
      try { localStorage.removeItem('nabla_history'); } catch(e) {}
      renderHistory();
      toggleSidebar();
    }

    function setMode(mode) {
      currentMode = mode;
      document.getElementById('btn-chat').classList.toggle('active', mode === 'chat');
      document.getElementById('btn-work').classList.toggle('active', mode === 'work');
      
      const title = document.getElementById('header-title');
      if (mode === 'chat') {
        title.innerHTML = "⚡ Nabla AI (Hinglish)";
        title.style.color = "#f59e0b";
      } else {
        title.innerHTML = "💼 Nabla AI (Work Mode)";
        title.style.color = "#38bdf8";
      }
      toggleSidebar();
    }

    function handleFile(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(e) {
        attachedFileText = e.target.result;
        document.getElementById('promptInput').value += ' [Attached: ' + file.name + '] ';
      };
      reader.readAsText(file);
    }

    function startVoice() {
      if (!('webkitSpeechRecognition' in window)) return alert("Voice not supported in this browser.");
      const recognition = new webkitSpeechRecognition();
      recognition.lang = 'en-IN'; 
      recognition.interimResults = false;
      
      const micBtn = document.getElementById('micBtn');
      micBtn.classList.add('recording');
      
      recognition.onresult = function(event) {
        document.getElementById('promptInput').value += event.results[0][0].transcript;
      };
      recognition.onend = function() { micBtn.classList.remove('recording'); };
      recognition.start();
    }

    async function sendPrompt() {
      const input = document.getElementById('promptInput');
      let prompt = input.value;
      const sendBtn = document.getElementById('sendBtn');
      
      if (!prompt && !attachedFileText) return;
      
      let finalPrompt = prompt;
      if (attachedFileText) {
        finalPrompt += '\n\n[FILE CONTENT START]\n' + attachedFileText + '\n[FILE CONTENT END]';
      }

      chatBox.innerHTML += '<div class="message user">' + formatText(prompt) + '</div>';
      chatHistory.push({ role: "user", content: finalPrompt });
      
      input.value = "";
      attachedFileText = ""; 
      sendBtn.disabled = true;
      chatBox.scrollTop = chatBox.scrollHeight;

      const aiMsgId = "ai-" + Date.now();
      chatBox.innerHTML += '<div class="message ai" id="' + aiMsgId + '">...</div>';
      const aiMsgDiv = document.getElementById(aiMsgId);
      let fullReply = "";

      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-app-password': localStorage.getItem('nabla_pass') || SECURE_PASSWORD
          },
          body: JSON.stringify({ messages: chatHistory, mode: currentMode })
        });
        
        if (!res.ok) throw new Error("Network error");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          fullReply += chunk;
          aiMsgDiv.innerHTML = formatText(fullReply); 
          chatBox.scrollTop = chatBox.scrollHeight;
        }
        
        chatHistory.push({ role: "assistant", content: fullReply });
        try { localStorage.setItem('nabla_history', JSON.stringify(chatHistory)); } catch(e) {}

      } catch (err) {
        aiMsgDiv.innerText = "❌ Error connecting to AI.";
      }
      sendBtn.disabled = false;
    }
  </script>
</body>
</html>`);
});

// --- 4. THE AI ENDPOINT ---
app.post('/api/generate', (req, res, next) => {
  if (req.headers['x-app-password'] !== "NablaAI@99") { 
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}, promptGuard, async (req, res) => {
  
  const messages = req.body.messages; 
  const mode = req.body.mode || 'chat'; 
  const userPrompt = messages[messages.length - 1].content; 
  const key = getKey();

  if (!key) return res.send("API key missing.");

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b', 
        messages: [{ role: "system", content: prompts[mode] }, ...messages],
        stream: true 
      }),
    });

    if (!response.ok) return res.send("AI limit reached.");

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
      chatsCollection.insertOne({ time: new Date(), mode: mode, prompt: userPrompt, reply: fullReply })
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
  console.log(`🚀 Nabla AI Server running on port ${port}`);
});
