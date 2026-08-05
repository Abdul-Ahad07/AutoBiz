require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Public folder for serving audio files
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
app.use('/public', express.static(publicDir));

// Groq SDK Client Initialization
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Environment Variables Configuration
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "Relation@1";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OWNER_SENDER_ID = process.env.OWNER_SENDER_ID || "37486899594288488";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "sk_09013ead49c26c04067271115e078d8c284ce1a1f62809aa";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Default Voice ID

// Global Memory for Owner Instructions
let activeCustomerRule = "Normal auto-reply mode: Answer customer queries politely and smartly.";

// In-Memory Chat Context (Per User)
const userSessions = {};

function getUserHistory(senderId) {
  if (!userSessions[senderId]) {
    userSessions[senderId] = [];
  }
  return userSessions[senderId];
}

function saveUserMessage(senderId, role, content) {
  const history = getUserHistory(senderId);
  history.push({ role, content });
  if (history.length > 8) {
    userSessions[senderId] = history.slice(-8);
  }
}

// 🎙️ 1. Speech-to-Text via Groq Whisper AI
async function transcribeVoiceMessage(audioUrl) {
  try {
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const file = await Groq.toFile(buffer, 'voice_message.mp4');

    const transcription = await groq.audio.transcriptions.create({
      file: file,
      model: "whisper-large-v3-turbo",
      response_format: "json"
    });

    return transcription.text;
  } catch (error) {
    console.error("❌ Whisper STT Error:", error.message || error);
    return null;
  }
}

// 🗣️ 2. Text-to-Speech via ElevenLabs API (With Safe Fallback)
async function generateVoiceNote(text, senderId) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });

    if (!response.ok) {
      if (response.status === 402) {
        console.error("⚠️ ElevenLabs Quota Exhausted (Error 402). Falling back to Text Reply.");
      } else {
        console.error(`❌ ElevenLabs API Error Status: ${response.status}`);
      }
      return null; // Null return hone par automatic text message send hoga
    }

    const buffer = await response.arrayBuffer();
    const fileName = `voice_${senderId}_${Date.now()}.mp3`;
    const filePath = path.join(publicDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(buffer));

    return fileName;
  } catch (error) {
    console.error("❌ ElevenLabs TTS Exception:", error.message || error);
    return null;
  }
}

// 🧠 3. Smart Natural Groq AI Engine
async function getGroqReply(senderId, userMessage, isOwner) {
  const history = getUserHistory(senderId);

  // OWNER PROMPT
  const ownerSystemPrompt = {
    role: "system",
    content: `You are texting on Messenger as a real human handling AutoBiz for your Boss, Sir Abdul Ahad.

PERSONA & RULES FOR BOSS:
1. Always address him respectfully as 'Sir' or 'Sir Abdul Ahad'.
2. Use everyday natural Roman Urdu mixed with light English (e.g., "Ji Sir bilkul", "Done ho gaya Sir", "Tension na lein").
3. Keep replies short, precise, and direct (1-2 sentences).
4. If Sir Abdul Ahad gives an instruction for customers (e.g., "agar koi msg kare to 2 ghante baad ka bolo"), acknowledge his order clearly.`
  };

  // CUSTOMER PROMPT
  const customerSystemPrompt = {
    role: "system",
    content: `You are texting on Messenger as a real human representative for AutoBiz (owned by Sir Abdul Ahad).

STRICT HUMAN TEXTING RULES:
1. Talk EXACTLY like a normal Pakistani texting on Messenger/WhatsApp using natural Roman Urdu and light English.
2. NEVER sound like an AI, customer service script, or formal bot. Absolutely NO Hindi words.
3. Keep it short (1-2 sentences max), relaxed, smart, and direct to the point.
4. If asked about owner/creator, reply: "Mere owner Sir Abdul Ahad hain."

CURRENT ACTIVE DIRECTION FROM BOSS:
"${activeCustomerRule}"`
  };

  const systemPrompt = isOwner ? ownerSystemPrompt : customerSystemPrompt;

  const fullMessages = [
    systemPrompt,
    ...history,
    { role: "user", content: userMessage }
  ];

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: fullMessages,
      model: "llama-3.3-70b-versatile",
      temperature: 0.5,
      max_tokens: 80
    });

    const aiReply = chatCompletion.choices[0]?.message?.content?.trim();

    if (aiReply) {
      if (isOwner) {
        const lowerMsg = userMessage.toLowerCase();
        if (lowerMsg.includes("ghante") || lowerMsg.includes("ghnte") || lowerMsg.includes("baad") || lowerMsg.includes("bolna") || lowerMsg.includes("busy")) {
          activeCustomerRule = `Owner Sir Abdul Ahad's custom rule: ${userMessage}`;
          console.log(`📌 Updated Active Rule: "${activeCustomerRule}"`);
        }
      }

      saveUserMessage(senderId, "user", userMessage);
      saveUserMessage(senderId, "assistant", aiReply);
      return aiReply;
    }

    return isOwner ? "Ji Sir!" : "Ji bilkul!";
  } catch (error) {
    console.error("❌ Groq AI Error:", error.message || error);
    return isOwner ? "Ji Sir!" : "Ji bilkul!";
  }
}

// 📤 4. Meta Messenger API Send Helpers
async function sendMetaTextMessage(senderId, text) {
  if (!PAGE_ACCESS_TOKEN) return;
  await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: { text: text }
    })
  });
}

async function sendMetaAudioMessage(senderId, audioPublicUrl) {
  if (!PAGE_ACCESS_TOKEN) return;
  await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: {
        attachment: {
          type: "audio",
          payload: {
            url: audioPublicUrl,
            is_reusable: true
          }
        }
      }
    })
  });
}

// Webhook Verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook Incoming Messages (POST)
app.post('/webhook', async (req, res) => {
  try {
    const messaging = req.body.entry?.[0]?.messaging?.[0];

    // Ignore page echo loops
    if (messaging && messaging.message && messaging.message.is_echo) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    if (messaging && messaging.sender && messaging.message) {
      const senderId = messaging.sender.id;
      const isOwner = senderId === OWNER_SENDER_ID;
      let userMessage = messaging.message.text;
      let isVoiceInput = false;

      // 🎙️ Voice Message Input Check
      const attachments = messaging.message.attachments;
      if (attachments && attachments[0] && attachments[0].type === 'audio') {
        isVoiceInput = true;
        const audioUrl = attachments[0].payload.url;
        console.log(`🎙️ Incoming Voice Message from ${senderId}...`);

        const transcribedText = await transcribeVoiceMessage(audioUrl);
        if (transcribedText) {
          userMessage = transcribedText;
          console.log(`📝 Transcribed Text: "${userMessage}"`);
        } else {
          userMessage = "Voice message clear nahi tha.";
        }
      }

      if (userMessage) {
        console.log(`📩 Processing message from ${senderId} ${isOwner ? '(OWNER)' : '(CUSTOMER)'}: "${userMessage}"`);

        const replyText = await getGroqReply(senderId, userMessage, isOwner);
        console.log(`🤖 AI Reply Text: "${replyText}"`);

        if (isVoiceInput) {
          // Voice Input -> Try Voice Output via ElevenLabs
          console.log("🔊 Generating ElevenLabs Voice Note...");
          const audioFileName = await generateVoiceNote(replyText, senderId);

          if (audioFileName) {
            const protocol = req.headers['x-forwarded-proto'] || 'https';
            const audioPublicUrl = `${protocol}://${req.headers.host}/public/${audioFileName}`;
            console.log(`🚀 Sending Voice Note URL: ${audioPublicUrl}`);
            await sendMetaAudioMessage(senderId, audioPublicUrl);
          } else {
            // Safe Fallback: Send Text if ElevenLabs fails or quota ends
            console.log("💬 Sending Text Fallback Reply...");
            await sendMetaTextMessage(senderId, replyText);
          }
        } else {
          // Text Input -> Text Output
          await sendMetaTextMessage(senderId, replyText);
        }
      }
    }
  } catch (err) {
    console.error("❌ Webhook Post Exception Error:", err);
  }

  res.status(200).send('EVENT_RECEIVED');
});

app.get('/', (req, res) => res.send('AutoBiz Voice & Text Server is Live!'));

app.listen(PORT, () => console.log(`🚀 AutoBiz server running on port ${PORT}`));