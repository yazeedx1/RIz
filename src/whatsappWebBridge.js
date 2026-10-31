const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT4_NODE_MODULES = path.join(
  os.homedir(),
  '.cache',
  'projects',
  'riz-assistant-c31f7611',
  'deps',
  'node_modules'
);
if (!module.paths.includes(EXT4_NODE_MODULES)) {
  module.paths.unshift(EXT4_NODE_MODULES);
}

const { handleIncomingWhatsAppMessage } = require('./whatsappEngine');
const { transcribeAudioWithGemini, synthesizeSpeechMp3 } = require('./voiceEngine');

const LOCAL_CACHE_WA_AUTH = path.join(
  os.homedir(),
  '.cache',
  'projects',
  'riz-assistant-c31f7611',
  'wa-auth'
);
const PROJECT_WA_AUTH = path.join(__dirname, '..', 'data', 'wa-auth');

const SESSION_DIR =
  process.env.WA_AUTH_DIR ||
  (fs.existsSync(LOCAL_CACHE_WA_AUTH) ? LOCAL_CACHE_WA_AUTH : PROJECT_WA_AUTH);

let activeSocket = null;
let currentSessionId = 0;
let bridgeStatus = {
  state: 'disconnected', // 'disconnected' | 'connecting' | 'pairing_code_ready' | 'qr_ready' | 'connected' | 'error'
  pairingCode: null,
  pairingPhone: null,
  qrCode: null,
  connectedUser: null,
  lastError: null,
  updatedAt: new Date().toISOString()
};

function getBridgeStatus() {
  return bridgeStatus;
}

function setBridgeStatus(patch) {
  bridgeStatus = {
    ...bridgeStatus,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  return bridgeStatus;
}

/**
 * Normalizes international phone numbers for WhatsApp pairing:
 * - Removes +, spaces, dashes, parentheses, and leading 00
 * - Strips accidental trunk '0' after country code (e.g. 96605... -> 9665...)
 */
function normalizeWhatsAppPhone(raw) {
  let digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  // Common Saudi / UAE / UK trunk zero mistake: +966 05... -> 9665...
  if (digits.startsWith('96605') && digits.length === 13) {
    digits = '9665' + digits.slice(5);
  } else if (digits.startsWith('97105') && digits.length === 13) {
    digits = '9715' + digits.slice(5);
  } else if (digits.startsWith('05') && digits.length === 10) {
    // Local 05XXXXXXXX format -> default to 9665XXXXXXXX
    digits = '966' + digits.slice(1);
  }
  return digits;
}

/**
 * Starts a live WhatsApp Multi-Device connection using @whiskeysockets/baileys.
 * Supports both QR Code scanning (when mode === 'qr' or phoneNumber is empty)
 * and 8-Digit Phone Pairing Code (when phoneNumber is provided).
 */
async function startLiveWhatsAppBridge({ phoneNumber = '', resetAuth = true } = {}) {
  let baileys;
  try {
    baileys = require('@whiskeysockets/baileys');
  } catch (err) {
    setBridgeStatus({
      state: 'error',
      lastError: 'WhatsApp Multi-Device library (@whiskeysockets/baileys) is not installed.'
    });
    throw new Error(bridgeStatus.lastError);
  }

  const sessionId = ++currentSessionId;

  // Cleanly close any previous socket so its events never overwrite the new session
  if (activeSocket) {
    try {
      activeSocket.ev.removeAllListeners('connection.update');
      activeSocket.ev.removeAllListeners('creds.update');
      activeSocket.ev.removeAllListeners('messages.upsert');
      activeSocket.end(undefined);
    } catch (_) {}
    activeSocket = null;
  }

  const cleanPhone = normalizeWhatsAppPhone(phoneNumber);

  // If starting a fresh pairing or QR flow, clear unregistered auth state so keys are fresh
  if (resetAuth && fs.existsSync(SESSION_DIR)) {
    try {
      const credsFile = path.join(SESSION_DIR, 'creds.json');
      let isRegistered = false;
      if (fs.existsSync(credsFile)) {
        const credsData = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
        isRegistered = Boolean(credsData && credsData.registered);
      }
      if (!isRegistered || cleanPhone) {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      }
    } catch (_) {}
  }

  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const makeWASocket = baileys.default || baileys.makeWASocket;
  const {
    useMultiFileAuthState,
    DisconnectReason,
    DEFAULT_CONNECTION_CONFIG,
    Browsers
  } = baileys;

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const version = (DEFAULT_CONNECTION_CONFIG && DEFAULT_CONNECTION_CONFIG.version) || [2, 3000, 1043857760];

  let pinoLogger;
  try {
    const pino = require('pino');
    pinoLogger = pino({ level: 'silent' });
  } catch (_) {}

  setBridgeStatus({
    state: 'connecting',
    pairingCode: null,
    pairingPhone: cleanPhone || null,
    qrCode: null,
    lastError: null
  });

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pinoLogger,
    browser: Browsers && Browsers.ubuntu ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false,
    markOnlineOnConnect: true
  });

  activeSocket = sock;
  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;

  sock.ev.on('connection.update', async (update) => {
    if (sessionId !== currentSessionId) return;

    const { connection, lastDisconnect, qr } = update;

    // Mode A: QR Code mode (no phone number passed)
    if (qr && !cleanPhone) {
      setBridgeStatus({
        state: 'qr_ready',
        qrCode: qr,
        pairingCode: null,
        lastError: null
      });
      console.log('📷 [Riz WhatsApp Bridge] New QR Code ready to scan!');
    }

    // Mode B: 8-Digit Phone Pairing Code mode (wait until `qr` event fires, which guarantees noise handshake is ready!)
    const isAlreadyLinked = Boolean(
      (state && state.creds && (state.creds.registered || state.creds.me)) ||
        (sock.authState && sock.authState.creds && (sock.authState.creds.registered || sock.authState.creds.me))
    );
    if (cleanPhone && !isAlreadyLinked && !pairingRequested && qr) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(cleanPhone);
        const formatted = code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        setBridgeStatus({
          state: 'pairing_code_ready',
          pairingCode: formatted,
          pairingPhone: `+${cleanPhone}`,
          qrCode: qr,
          lastError: null
        });
        console.log(`\n🔑 [Riz WhatsApp Pairing Code for +${cleanPhone}]: ${formatted}`);
      } catch (err) {
        setBridgeStatus({
          state: 'error',
          lastError: `Failed to request pairing code for +${cleanPhone}: ${err.message}`
        });
      }
    }

    if (connection === 'open') {
      setBridgeStatus({
        state: 'connected',
        pairingCode: null,
        qrCode: null,
        connectedUser: sock.user ? sock.user.id.split(':')[0] : cleanPhone,
        lastError: null
      });
      console.log('✅ [Riz WhatsApp Bridge] Connected to WhatsApp! Listening for "Riz"...');
    } else if (connection === 'close') {
      const statusCode =
        lastDisconnect &&
        lastDisconnect.error &&
        lastDisconnect.error.output &&
        lastDisconnect.error.output.statusCode;
      const errMsg =
        lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : 'Connection closed';

      if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
        console.log('🔄 [Riz WhatsApp Bridge] Stream restart required after pairing, reconnecting...');
        setTimeout(() => {
          if (sessionId === currentSessionId) {
            startLiveWhatsAppBridge({ phoneNumber: '', resetAuth: false }).catch(() => {});
          }
        }, 1200);
        return;
      }

      if (isAlreadyLinked && statusCode !== DisconnectReason.loggedOut) {
        console.log(`🔄 [Riz WhatsApp Bridge] Connection dropped (${errMsg}), auto-reconnecting in 2s...`);
        setTimeout(() => {
          if (sessionId === currentSessionId) {
            startLiveWhatsAppBridge({ phoneNumber: '', resetAuth: false }).catch(() => {});
          }
        }, 2000);
        return;
      }

      if (bridgeStatus.state !== 'pairing_code_ready' && bridgeStatus.state !== 'qr_ready') {
        setBridgeStatus({
          state: 'error',
          lastError: `WhatsApp connection closed (${errMsg}). Click "Show QR Code" or "Get 8-Digit Code" to try again.`
        });
      }
    }
  });

  const sentByRizIds = new Set();

  sock.ev.on('messages.upsert', async (event) => {
    if (sessionId !== currentSessionId) return;
    if (event.type !== 'notify' && event.type !== 'append') return;
    for (const msg of event.messages || []) {
      if (!msg.message || !msg.key) continue;
      if (sentByRizIds.has(msg.key.id)) continue;

      // For 'append' (history sync after reconnect), only process recent messages (< 10 min old) not sent by Riz
      if (event.type === 'append') {
        const tsSec = Number(msg.messageTimestamp || 0);
        if (!tsSec || Date.now() - tsSec * 1000 > 10 * 60 * 1000) continue;
      }
      sentByRizIds.add(msg.key.id);

      const remoteJid = msg.key.remoteJid || '';
      if (remoteJid === 'status@broadcast') continue;

      const innerMsg =
        (msg.message.ephemeralMessage && msg.message.ephemeralMessage.message) ||
        (msg.message.viewOnceMessage && msg.message.viewOnceMessage.message) ||
        msg.message;

      const audioMsg = innerMsg.audioMessage || null;
      let isVoiceMessage = false;
      let text =
        innerMsg.conversation ||
        (innerMsg.extendedTextMessage && innerMsg.extendedTextMessage.text) ||
        '';

      if (audioMsg && !text) {
        isVoiceMessage = true;
        try {
          await sock.sendPresenceUpdate('recording', remoteJid).catch(() => {});
          const downloadMediaMessage = baileys.downloadMediaMessage;
          if (typeof downloadMediaMessage === 'function') {
            const audioBuffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              { logger: pinoLogger, reuploadRequest: sock.updateMediaMessage }
            );
            text = await transcribeAudioWithGemini({
              audioBuffer,
              mimeType: audioMsg.mimetype || 'audio/ogg'
            });
            console.log(`🎙️ [Riz WhatsApp Voice Transcript]: "${text}"`);
          }
        } catch (err) {
          console.error('[Riz Voice Note Download/Transcribe Error]:', err.message);
        }
      }

      if (!text || text.startsWith('🤖 *Riz:*')) continue;

      const isGroup = remoteJid.endsWith('@g.us');
      const senderName = msg.pushName || (msg.key.participant || remoteJid).split('@')[0] || 'WhatsApp User';

      // Show immediate typing/recording indicator so user sees instant feedback
      sock.sendPresenceUpdate(isVoiceMessage ? 'recording' : 'composing', remoteJid).catch(() => {});

      const result = await handleIncomingWhatsAppMessage({
        chatId: remoteJid,
        senderName,
        senderPhone: (msg.key.participant || remoteJid).split('@')[0],
        chatName: isGroup ? 'WhatsApp Group' : senderName,
        chatType: isGroup ? 'group' : 'dm',
        messageText: text,
        isVoiceMessage
      });

      if (result.triggered && result.reply) {
        // Send text reply immediately for fast readability
        const sent = await sock.sendMessage(
          remoteJid,
          { text: result.reply },
          { quoted: msg }
        );
        if (sent && sent.key && sent.key.id) {
          sentByRizIds.add(sent.key.id);
        }

        // If caller sent a voice note or voice mode is active, also send a spoken voice note!
        if (result.sendVoiceReply) {
          try {
            await sock.sendPresenceUpdate('recording', remoteJid).catch(() => {});
            const mp3Buffer = await synthesizeSpeechMp3(result.reply);
            if (mp3Buffer && mp3Buffer.length > 0) {
              const sentAudio = await sock.sendMessage(
                remoteJid,
                {
                  audio: mp3Buffer,
                  mimetype: 'audio/mpeg',
                  ptt: true
                },
                { quoted: msg }
              );
              if (sentAudio && sentAudio.key && sentAudio.key.id) {
                sentByRizIds.add(sentAudio.key.id);
              }
            }
          } catch (voiceErr) {
            console.error('[Riz Voice Reply Send Error]:', voiceErr.message);
          }
        }
        sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
      }
    }
  });

  // Handle incoming WhatsApp Voice/Video Call offers by replying with a live Voice Note + Call Room link
  const handledCallIds = new Set();
  sock.ev.on('call', async (calls) => {
    if (sessionId !== currentSessionId) return;
    for (const call of calls || []) {
      if (!call || call.status !== 'offer' || !call.from) continue;
      if (handledCallIds.has(call.id)) continue;
      handledCallIds.add(call.id);

      try {
        const callerJid = call.from;
        let publicCallUrl = 'http://localhost:3456/call';
        try {
          const urlFile = path.join(__dirname, '..', 'data', 'public-call-url.json');
          if (fs.existsSync(urlFile)) {
            const parsed = JSON.parse(fs.readFileSync(urlFile, 'utf8'));
            if (parsed && parsed.callUrl) publicCallUrl = parsed.callUrl;
          }
        } catch (_) {}
        const callGreeting =
          `Hey! It's Riz, Yazeed's AI assistant. Talk to me right here on WhatsApp by sending a Voice Note, or tap ${publicCallUrl} for a live hands-free voice call!`;
        await sock.sendMessage(callerJid, { text: callGreeting });
        const mp3Buffer = await synthesizeSpeechMp3(callGreeting);
        if (mp3Buffer && mp3Buffer.length > 0) {
          await sock.sendMessage(callerJid, {
            audio: mp3Buffer,
            mimetype: 'audio/mpeg',
            ptt: true
          });
        }
      } catch (_) {}
    }
  });

  return getBridgeStatus();
}

let watchdogStarted = false;

function autoConnectIfRegistered() {
  const tryConnect = () => {
    try {
      const credsFile = path.join(SESSION_DIR, 'creds.json');
      if (fs.existsSync(credsFile)) {
        const credsData = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
        if (credsData && (credsData.registered || credsData.me)) {
          console.log('🔄 [Riz WhatsApp Bridge] Found existing linked WhatsApp session, auto-connecting...');
          startLiveWhatsAppBridge({ phoneNumber: '', resetAuth: false }).catch((err) => {
            console.error('[Riz Auto-Connect Error]:', err.message);
          });
        }
      }
    } catch (_) {}
  };

  tryConnect();

  if (!watchdogStarted) {
    watchdogStarted = true;
    setInterval(() => {
      if (bridgeStatus.state === 'error' || bridgeStatus.state === 'disconnected') {
        tryConnect();
      }
    }, 12000);
  }
}

module.exports = {
  startLiveWhatsAppBridge,
  getBridgeStatus,
  normalizeWhatsAppPhone,
  autoConnectIfRegistered
};
