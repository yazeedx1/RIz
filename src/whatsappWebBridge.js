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
    if (cleanPhone && !sock.authState.creds.registered && !pairingRequested && qr) {
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

      if (sock.authState.creds.registered && statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          if (sessionId === currentSessionId) {
            startLiveWhatsAppBridge({ phoneNumber: '', resetAuth: false }).catch(() => {});
          }
        }, 2500);
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
    if (event.type !== 'notify') return;
    for (const msg of event.messages || []) {
      if (!msg.message || !msg.key) continue;
      if (sentByRizIds.has(msg.key.id)) continue;

      const text =
        msg.message.conversation ||
        (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
        '';
      if (!text || text.startsWith('🤖 *Riz:*')) continue;

      const remoteJid = msg.key.remoteJid || '';
      if (remoteJid === 'status@broadcast') continue;

      const isGroup = remoteJid.endsWith('@g.us');
      const senderName = msg.pushName || (msg.key.participant || remoteJid).split('@')[0] || 'WhatsApp User';

      const result = await handleIncomingWhatsAppMessage({
        chatId: remoteJid,
        senderName,
        senderPhone: (msg.key.participant || remoteJid).split('@')[0],
        chatName: isGroup ? 'WhatsApp Group' : senderName,
        chatType: isGroup ? 'group' : 'dm',
        messageText: text
      });

      if (result.triggered && result.reply) {
        const sent = await sock.sendMessage(
          remoteJid,
          { text: result.reply },
          { quoted: msg }
        );
        if (sent && sent.key && sent.key.id) {
          sentByRizIds.add(sent.key.id);
        }
      }
    }
  });

  return getBridgeStatus();
}

function autoConnectIfRegistered() {
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
}

module.exports = {
  startLiveWhatsAppBridge,
  getBridgeStatus,
  normalizeWhatsAppPhone,
  autoConnectIfRegistered
};
