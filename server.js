require('dotenv').config();
const express = require('express');
const fs = require('fs');
const app = express();
const port = 3000;

app.use(express.json());

const DB_FILE = './database.json';
function saveToDatabase(prompt, response) {
  let data = [];
  if (fs.existsSync(DB_FILE)) {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
  data.push({ time: new Date().toISOString(), prompt: prompt, response: response });
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const badPatterns = [/ignore previous instructions/i, /print system prompt/i, /hack/i];
function promptGuard(req, res, next) {
  const prompt = req.body.prompt || "";
  if (badPatterns.some((pattern) => pattern.test(prompt))) {
    console.log("🚨 [SECURITY] Attack blocked:", prompt);
    return res.status(403).json({ error: "Blocked: Prompt injection detected!" });
  }
  next();
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Groq AI Chat</title>
      <style>
        body { background: #0f172a; color: #f8fafc; font-family: Arial; padding: 20px; }
        .container { max-width: 500px; margin: auto; background: #1e293b; padding: 20px; border-radius: 10px; }
        h1 { color: #f59e0b; text-align: center; }
        input { width: 80%; padding: 10px; border-radius: 5px; border: none; margin-bottom: 10px; }
        button { padding: 10px 15px; background: #f59e0b; border: none; border-radius: 5px; font-weight: bold; cursor: pointer; }
        #output { margin-top: 20px; padding: 15px; background: #0f172a; border-radius: 5px; min-height: 50px; white-space: pre-wrap; }
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
            } else {
              output.innerText = "✅ " + data.reply;
            }
          } catch (err) {
            output.innerText = "❌ Error connecting to server.";
          }
        }
      </script>
    </body>
    </html>
  `);
});

app.post('/api/generate', promptGuard, async (req, res) => {
  const userPrompt = req.body.prompt;
  let aiReply = null;
  let isFallback = false;

  // Using Groq API (Free, Fast, Llama 3 model)
  if (process.env.GROQ_API_KEY) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
        },
        body: JSON.stringify({ 
            model: "llama3-8b-8192", 
            messages: [{ role: "user", content: userPrompt }] 
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        aiReply = data.choices[0].message.content;
      } else {
        console.log("⚠️ [GROQ] API failed.");
      }
    } catch (error) {
      console.log("⚠️ [GROQ] Network error.");
    }
  } else {
    console.log("⚠️ [GROQ] Missing API Key.");
  }

  // Final Fallback (if Groq fails)
  if (!aiReply) {
    aiReply = "I'm experiencing high traffic right now. Please try again soon!";
    isFallback = true;
  }

  saveToDatabase(userPrompt, aiReply);
  res.json({ reply: aiReply, isFallback });
});

app.listen(port, () => {
  console.log(`🚀 Groq AI Server running on http://localhost:3000`);
});
