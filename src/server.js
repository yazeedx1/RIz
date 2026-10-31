const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { loadState, saveState, updateConfig, updateOwnerProfile } = require('./configStore');
const { processRizMessage } = require('./rizBrain');
const { handleIncomingWhatsAppMessage, getAllSessions } = require('./whatsappEngine');
const { startLiveWhatsAppBridge, getBridgeStatus, autoConnectIfRegistered } = require('./whatsappWebBridge');
const { executeTool, TOOL_DECLARATIONS } = require('./tools');
const { transcribeAudioWithGemini, synthesizeSpeechMp3 } = require('./voiceEngine');

const PORT = Number(process.env.PORT) || 3456;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 15 * 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    try {
      // 1. Get full assistant state
      if (req.method === 'GET' && pathname === '/api/state') {
        const state = loadState();
        const maskedConfig = {
          ...state.config,
          geminiApiKeyConfigured: Boolean(state.config.geminiApiKey && state.config.geminiApiKey.length > 10),
          geminiApiKeyPreview: state.config.geminiApiKey
            ? `${state.config.geminiApiKey.slice(0, 6)}...${state.config.geminiApiKey.slice(-4)}`
            : ''
        };
        return sendJson(res, 200, {
          ...state,
          config: maskedConfig,
          whatsappBridge: getBridgeStatus(),
          activeSessions: getAllSessions(),
          tools: TOOL_DECLARATIONS
        });
      }

      // 1b. Request WhatsApp 8-Digit Phone Pairing Code or QR Code
      if (req.method === 'POST' && pathname === '/api/whatsapp/pair') {
        const body = await readJsonBody(req);
        await startLiveWhatsAppBridge({ phoneNumber: body.phoneNumber || '' });
        return sendJson(res, 200, getBridgeStatus());
      }

      if (req.method === 'GET' && pathname === '/api/whatsapp/bridge-status') {
        return sendJson(res, 200, getBridgeStatus());
      }

      // 2. Update assistant configuration (trigger word, password, model, API keys, group/DM rules)
      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readJsonBody(req);
        const updated = updateConfig(body);
        return sendJson(res, 200, { status: 'updated', config: updated });
      }

      // 2b. Update Owner Profile (location "where am I", availability, working hours, bio)
      if (req.method === 'POST' && pathname === '/api/owner-profile') {
        const body = await readJsonBody(req);
        const updated = updateOwnerProfile(body);
        return sendJson(res, 200, { status: 'updated', ownerProfile: updated });
      }

      // 3. Toggle or add Connected Account / App
      if (req.method === 'POST' && pathname === '/api/accounts/toggle') {
        const body = await readJsonBody(req);
        const state = loadState();
        const target = state.accounts.find((a) => a.id === body.id);
        if (!target) {
          return sendJson(res, 404, { error: 'Account connector not found' });
        }
        if (typeof body.connected === 'boolean') {
          target.connected = body.connected;
        } else {
          target.connected = !target.connected;
        }
        if (body.mode) target.mode = body.mode;
        saveState(state);
        return sendJson(res, 200, { status: 'ok', account: target });
      }

      // 4. Direct Chat with Riz
      if (req.method === 'POST' && pathname === '/api/chat') {
        const body = await readJsonBody(req);
        const result = await processRizMessage({
          message: body.message || '',
          sender: body.sender || 'Owner',
          source: 'dashboard-chat'
        });
        if (body.withVoice && result.reply) {
          const mp3 = await synthesizeSpeechMp3(result.reply);
          if (mp3) result.audioBase64 = mp3.toString('base64');
        }
        return sendJson(res, 200, result);
      }

      // 4b. Live Voice Chat with Riz (Audio -> Gemini Multimodal Transcription -> Real Tools -> Spoken MP3 Audio Reply)
      if (req.method === 'POST' && pathname === '/api/voice/chat') {
        const body = await readJsonBody(req);
        let transcript = (body.text || '').trim();
        if (!transcript && body.audioBase64) {
          const audioBuffer = Buffer.from(body.audioBase64, 'base64');
          transcript = await transcribeAudioWithGemini({
            audioBuffer,
            mimeType: body.mimeType || 'audio/webm'
          });
        }
        if (!transcript) {
          return sendJson(res, 400, { error: 'Could not hear speech clearly. Please try speaking again.' });
        }
        const result = await processRizMessage({
          message: transcript,
          sender: body.sender || 'Owner',
          source: 'voice-chat'
        });
        const mp3 = result.reply ? await synthesizeSpeechMp3(result.reply) : null;
        return sendJson(res, 200, {
          transcript,
          ...result,
          audioBase64: mp3 ? mp3.toString('base64') : null,
          audioMimeType: 'audio/mpeg'
        });
      }

      // 4c. On-demand Text-to-Speech endpoint
      if (req.method === 'POST' && pathname === '/api/voice/tts') {
        const body = await readJsonBody(req);
        const mp3 = await synthesizeSpeechMp3(body.text || '');
        if (!mp3) {
          return sendJson(res, 500, { error: 'TTS generation failed' });
        }
        return sendJson(res, 200, {
          audioBase64: mp3.toString('base64'),
          audioMimeType: 'audio/mpeg'
        });
      }

      // 5. WhatsApp Simulator / Incoming Bridge Message
      if (req.method === 'POST' && pathname === '/api/whatsapp/incoming') {
        const body = await readJsonBody(req);
        let messageText = body.messageText || '';
        const isVoiceMessage = Boolean(body.isVoiceMessage || body.audioBase64);
        if (!messageText && body.audioBase64) {
          const audioBuffer = Buffer.from(body.audioBase64, 'base64');
          messageText = await transcribeAudioWithGemini({
            audioBuffer,
            mimeType: body.mimeType || 'audio/webm'
          });
        }
        const result = await handleIncomingWhatsAppMessage({
          chatId: body.chatId || `sim-${body.chatType || 'group'}`,
          senderName: body.senderName || 'Alex',
          senderPhone: body.senderPhone || '+15550192834',
          chatName: body.chatName || 'Project Squad Group',
          chatType: body.chatType || 'group',
          messageText,
          isVoiceMessage
        });
        if (result.triggered && result.reply && (result.sendVoiceReply || body.withVoice)) {
          const mp3 = await synthesizeSpeechMp3(result.reply);
          if (mp3) result.audioBase64 = mp3.toString('base64');
        }
        result.transcribedText = messageText;
        return sendJson(res, 200, result);
      }

      // 6. Official Meta WhatsApp Cloud API Webhook Verification (GET)
      if (req.method === 'GET' && pathname === '/api/whatsapp/webhook') {
        const mode = parsedUrl.searchParams.get('hub.mode');
        const token = parsedUrl.searchParams.get('hub.verify_token');
        const challenge = parsedUrl.searchParams.get('hub.challenge');
        const state = loadState();
        if (mode === 'subscribe' && token === state.config.whatsappVerifyToken) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(challenge || '');
        }
        return sendJson(res, 403, { error: 'Webhook verification token mismatch' });
      }

      // 7. Official Meta WhatsApp Cloud API Incoming Webhook (POST)
      if (req.method === 'POST' && pathname === '/api/whatsapp/webhook') {
        const body = await readJsonBody(req);
        const entries = body.entry || [];
        const results = [];
        for (const entry of entries) {
          for (const change of entry.changes || []) {
            const value = change.value || {};
            const contacts = value.contacts || [];
            const messages = value.messages || [];
            for (const msg of messages) {
              if (msg.type === 'text' && msg.text && msg.text.body) {
                const contact = contacts.find((c) => c.wa_id === msg.from) || {};
                const senderName = (contact.profile && contact.profile.name) || msg.from || 'WhatsApp User';
                const r = await handleIncomingWhatsAppMessage({
                  chatId: msg.from,
                  senderName,
                  senderPhone: msg.from,
                  chatName: senderName,
                  chatType: 'dm',
                  messageText: msg.text.body
                });
                results.push(r);
              }
            }
          }
        }
        return sendJson(res, 200, { status: 'processed', results });
      }

      // 8. Execute any tool directly from dashboard
      if (req.method === 'POST' && pathname === '/api/tools/execute') {
        const body = await readJsonBody(req);
        const output = await executeTool(body.name, body.arguments || {});
        return sendJson(res, 200, output);
      }

      // 9. Toggle Task completion
      if (req.method === 'POST' && pathname === '/api/tasks/toggle') {
        const body = await readJsonBody(req);
        const state = loadState();
        const task = state.tasks.find((t) => t.id === body.id);
        if (task) {
          task.completed = !task.completed;
          saveState(state);
        }
        return sendJson(res, 200, { status: 'ok', tasks: state.tasks });
      }

      // Serve static files from public/
      const safePath = pathname === '/' ? '/index.html' : pathname;
      const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));
      if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        return fs.createReadStream(filePath).pipe(res);
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🤖 Riz AI Assistant Server running at http://localhost:${PORT}`);
    autoConnectIfRegistered();
  });
}

module.exports = { createServer };
