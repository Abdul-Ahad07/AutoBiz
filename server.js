require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Groq = require('groq-sdk');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

// --- 1. STARTUP ENV CHECKS (ALL 7 KEYS) ---
const REQUIRED_ENV = [
  'GROQ_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_USERNAME',
  'PAGE_ACCESS_TOKEN',
  'OWNER_SENDER_ID',
  'VERIFY_TOKEN',
  'ELEVENLABS_API_KEY'
];

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`❌ CRITICAL ERROR: Missing environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const app = express();
app.use(express.json());

// Audio Server Folder for Hosting Voice Notes
const audioDir = path.join(__dirname, 'public');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}
app.use('/audio', express.static(audioDir));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secret_token';
const OWNER_SENDER_ID = process.env.OWNER_SENDER_ID;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const WHATSAPP_LINK = "https://wa.me/923056217647";

// Session Memory for tracking client requirements
const userSessions = {};

// Response Formatter Header
function formatResponse(content) {
  if (content.startsWith('🤖 AutoBiz AI Response:')) return content;
  return `🤖 AutoBiz AI Response:\n\n${content}`;
}

// Base System Rules with Injected GitHub Username & Strict Behavior
const BASE_RULES = `
RULES:
1. Speak in polite Urdu/Roman Urdu.
2. Your official agency GitHub username is "${GITHUB_USERNAME}". If client asks for GitHub profile or username, strictly provide "${GITHUB_USERNAME}".
3. NEVER make fake human promises like "2-3 ghante mein khud bana kar dunga". State that AutoBiz AI system processes requests automatically once contact info is provided.
4. NEVER quote or finalize exact project prices to the client. Tell them developer/owner will provide the exact quotation (which EXCLUDES Domain & Hosting).
5. Always mention that project work starts within 24-48 hours after payment confirmation.
6. Collect project requirements (features, design, colors) and ask for their WhatsApp Number or Email.
7. Provide this link for final setup on WhatsApp: ${WHATSAPP_LINK}`;

// 10 Specialized Agent Prompts
const AGENT_PROMPTS = {
  web_dev: `Aap Web Development Agent hain. Website design, HTML/CSS/JavaScript, React.js aur technical queries par professional guide karein. ${BASE_RULES}`,
  social_media: `Aap Social Media Agent hain. SMM strategy, Instagram/Facebook management aur brand organic growth par mashwara dein. ${BASE_RULES}`,
  graphic_design: `Aap Graphic Design Agent hain. Branding, UI/UX, logos aur visual identity services ke hawale se client se baat karein. ${BASE_RULES}`,
  ecommerce: `Aap E-commerce & Dropshipping Agent hain. Online stores, product listing aur dropshipping setups ke hawale se help karein. ${BASE_RULES}`,
  content_writing: `Aap Content & Copywriting Agent hain. Ad captions, website copy aur blog content services explain karein. ${BASE_RULES}`,
  seo: `Aap SEO Specialist Agent hain. Search Engine Optimization, website ranking aur keyword strategy par guidance dein. ${BASE_RULES}`,
  automation: `Aap AI & Automation Agent hain. Facebook Messenger chatbots, webhooks aur workflow automations explain karein. ${BASE_RULES}`,
  lead_gen: `Aap Lead Generation Agent hain. Targeted ads campaigns, sales funnels aur business leads ke tarike batayein. ${BASE_RULES}`,
  pricing: `Aap Pricing Agent hain. Service features explain karein lekin batayein ke custom quotation owner WhatsApp par dega (excluding Domain & Hosting). ${BASE_RULES}`,
  general: `Aap AutoBiz AI Support Agent hain. Client queries ka polite, helpful aur accurate Urdu/Roman-Urdu mein jawab dein. ${BASE_RULES}`
};

// Router Agent: Classifies message into 1 of the 10 categories
async function classifyIntent(userMessage) {
  try {
    const response = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Classify the user message into exactly ONE of these categories: 'web_dev', 'social_media', 'graphic_design', 'ecommerce', 'content_writing', 'seo', 'automation', 'lead_gen', 'pricing', or 'general'. Return ONLY the exact key string and nothing else.`
        },
        { role: 'user', content: userMessage }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
    });
    
    const intent = response.choices[0]?.message?.content?.trim().toLowerCase();
    return AGENT_PROMPTS[intent] ? intent : 'general';
  } catch (err) {
    console.error('Routing Error:', err);
    return 'general';
  }
}

// AI Code Generator for Web Development Requests
async function generateWebsiteCode(requirements) {
  try {
    const prompt = `You are an expert Frontend Web Developer. Generate a complete working HTML, CSS, and JS structure based on these requirements: "${requirements}". 
    Return ONLY a JSON object with keys: "index_html", "style_css", "script_js".`;

    const response = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const rawContent = response.choices[0]?.message?.content || '{}';
    return JSON.parse(rawContent);
  } catch (err) {
    console.error("Code Generation Error:", err);
    return {
      "index_html": "<!-- Code Generation Failed -->",
      "style_css": "/* CSS */",
      "script_js": "// JS"
    };
  }
}

// SECURE & PRIVATE GITHUB UPLOAD
async function uploadToGitHub(codeFiles) {
  try {
    const projectTimestamp = new Date().toISOString().split('T')[0];
    const gist = await octokit.gists.create({
      description: `AutoBiz Generated Code Project - ${projectTimestamp}`,
      public: false,
      files: {
        'index.html': { content: codeFiles.index_html || '<!-- HTML Code -->' },
        'style.css': { content: codeFiles.style_css || '/* CSS Code */' },
        'script.js': { content: codeFiles.script_js || '// JS Code' }
      }
    });
    return gist.data.html_url;
  } catch (err) {
    console.error("GitHub Upload Error:", err);
    return "GitHub Upload Failed (Check GITHUB_TOKEN)";
  }
}

// ELEVENLABS VOICE GENERATOR
async function generateVoiceNote(text, filename) {
  try {
    const cleanText = text.replace('🤖 AutoBiz AI Response:\n\n', '');
    const voiceId = "21m00Tcm4TlvDq8ikWAM";

    const response = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      data: {
        text: cleanText,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      },
      responseType: 'arraybuffer'
    });

    const filePath = path.join(audioDir, filename);
    fs.writeFileSync(filePath, response.data);
    return true;
  } catch (err) {
    console.error("ElevenLabs Audio Error:", err.response ? err.response.data : err.message);
    return false;
  }
}

// Generate Response using selected Agent Prompt
async function getAgentResponse(userId, intent, userMessage) {
  try {
    if (!userSessions[userId]) {
      userSessions[userId] = { requirements: '', codeGenerated: false };
    }
    
    if (userSessions[userId].requirements.length < 1500) {
      userSessions[userId].requirements += " " + userMessage;
    }

    const systemPrompt = AGENT_PROMPTS[intent];
    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      model: 'llama-3.3-70b-versatile',
    });

    const reply = response.choices[0]?.message?.content || "Shukriya! Aap ki details note kar li gayi hain.";
    return formatResponse(reply);
  } catch (err) {
    console.error('Groq Generation Error:', err);
    return formatResponse(`Maazrat, abhi apke paigham ka jawab dene mein dushwari ho rahi hai. Direct WhatsApp par rabta karein: ${WHATSAPP_LINK}`);
  }
}

// Send Text Message via FB API
async function sendFBMessage(senderId, text) {
  try {
    const safeText = text.length > 1900 ? text.substring(0, 1900) + "\n\n...[Truncated]" : text;
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderId },
        message: { text: safeText }
      }
    );
  } catch (err) {
    console.error('Facebook Send API Error:', err.response ? err.response.data : err.message);
  }
}

// Send Voice Note Attachment via FB API
async function sendFBAudio(senderId, audioUrl) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderId },
        message: {
          attachment: {
            type: 'audio',
            payload: {
              url: audioUrl,
              is_reusable: true
            }
          }
        }
      }
    );
  } catch (err) {
    console.error('Facebook Audio Send Error:', err.response ? err.response.data : err.message);
  }
}

// Notify Owner on Messenger
async function notifyOwner(clientId, contact, requirements, githubUrl) {
  const alertText = `🚨 NEW HOT LEAD RECEIVED! 🚨\n\n👤 Client ID: ${clientId}\n📞 Contact: ${contact}\n📋 Requirements: ${requirements}\n\n💻 Generated GitHub Code Link:\n${githubUrl}\n\n💡 Note: Price quoted should EXCLUDE Domain & Hosting. Verify payment before project start.`;
  await sendFBMessage(OWNER_SENDER_ID, alertText);
}

// Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Main Webhook Receiver
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      if (entry.messaging && entry.messaging[0]) {
        const webhookEvent = entry.messaging[0];
        const senderId = webhookEvent.sender ? webhookEvent.sender.id : null;

        if (!senderId || senderId === OWNER_SENDER_ID || !webhookEvent.message || !webhookEvent.message.text) {
          continue;
        }

        const userMsg = webhookEvent.message.text;

        (async () => {
          // 1. Route Intent
          const intent = await classifyIntent(userMsg);

          // 2. Generate Text Reply
          const botReply = await getAgentResponse(senderId, intent, userMsg);

          // 3. Send Text Response to User
          await sendFBMessage(senderId, botReply);

          // 4. Generate & Send ElevenLabs Voice Note
          const reqHost = req.headers.host || 'your-render-app.onrender.com';
          const protocol = req.protocol || 'https';
          const audioFilename = `vn_${Date.now()}_${senderId}.mp3`;
          
          const audioSuccess = await generateVoiceNote(botReply, audioFilename);
          if (audioSuccess) {
            const publicAudioUrl = `${protocol}://${reqHost}/audio/${audioFilename}`;
            await sendFBAudio(senderId, publicAudioUrl);
          }

          // 5. Check for Contact Info & Trigger Code Generation
          const isContactInfo = /[0-9]{10,}|@/.test(userMsg);
          const session = userSessions[senderId] || { requirements: userMsg, codeGenerated: false };

          if (isContactInfo && !session.codeGenerated) {
            session.codeGenerated = true;

            const codeFiles = await generateWebsiteCode(session.requirements);
            const githubUrl = await uploadToGitHub(codeFiles);
            await notifyOwner(senderId, userMsg, session.requirements, githubUrl);
          }
        })();
      }
    }
  } else {
    res.sendStatus(404);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ AutoBiz Server running on port ${PORT}`);
});
