const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'riz-store.json');

/**
 * Loads key=value pairs from ~/.env and project .env without leaking values to logs.
 */
function loadDotEnvVars() {
  const vars = {};
  const candidates = [
    path.join(os.homedir(), '.env'),
    path.join(__dirname, '..', '.env')
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).trim();
            const v = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            if (k && v) vars[k] = v;
          }
        }
      }
    } catch (_) {}
  }
  return vars;
}

const envVars = loadDotEnvVars();

const DEFAULT_STATE = {
  config: {
    assistantName: 'Riz',
    triggerWords: ['Riz', 'hey riz', '@riz'],
    accessPassword: 'blacky',
    requirePasswordForOpenChat: true,
    model: 'gemini-3.8-flash',
    geminiApiKey: process.env.GEMINI_API_KEY || envVars.GEMINI_API_KEY || '',
    githubUsername: process.env.GITHUB_USERNAME || envVars.GITHUB_USERNAME || 'yazeedx1',
    githubToken: process.env.GITHUB_TOKEN || envVars.GITHUB_TOKEN || '',
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID || envVars.FIREBASE_PROJECT_ID || 'rizproject-e6d13',
    firebaseDatabaseUrl:
      process.env.FIREBASE_DATABASE_URL ||
      envVars.FIREBASE_DATABASE_URL ||
      'https://rizproject-e6d13-default-rtdb.firebaseio.com',
    whatsappEnabled: true,
    replyInGroups: true,
    replyInDMs: true,
    requireTriggerInDMs: true,
    whatsappPhoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'riz-verify-token-2026',
    systemInstruction:
      'You are Riz, the personal AI assistant for Yazeed Abdullah (Yaz). ' +
      'Never use canned templates or fake data. Write every reply freshly and naturally in your own words. ' +
      'Always use your real tools to inspect actual calendar events, real local code files, real Git/GitHub repositories, real emails, and real owner profile/location data. ' +
      'If an external account has no events or needs authentication, state that honestly and concisely.'
  },
  ownerProfile: {
    name: 'Yazeed Abdullah (Yaz)',
    currentLocation: 'Riyadh, Saudi Arabia',
    currentStatus: 'Available via Riz on WhatsApp',
    timezone: 'Asia/Riyadh (GMT+3)',
    workingHours: '09:00 AM – 05:00 PM',
    availabilitySummary: 'Check live Google Calendar and local schedule for current free slots.',
    bio: 'Software developer & AI builder.',
    generalInfo: 'Reachable through Riz on WhatsApp (+966555110550).',
    phone: '+966555110550'
  },
  accounts: [
    {
      id: 'whatsapp',
      name: 'WhatsApp Messenger',
      category: 'Messaging',
      icon: '💬',
      connected: true,
      mode: 'Live Multi-Device (+966555110550)',
      permissions: ['Trigger ("Riz") -> Password ("blacky") -> Open AI Conversation'],
      deeplink: 'https://wa.me/966555110550',
      tokenConfigured: true
    },
    {
      id: 'google_calendar',
      name: 'Google Calendar',
      category: 'Google Workspace',
      icon: '📅',
      connected: true,
      mode: 'Live gcalendar CLI + Real Event Store',
      permissions: ['Read real events', 'Create real meetings', 'Check free/busy availability'],
      deeplink: 'https://calendar.google.com',
      tokenConfigured: true
    },
    {
      id: 'codebase_and_git',
      name: 'Local Codebase & GitHub',
      category: 'Developer',
      icon: '🐙',
      connected: true,
      mode: 'Live Filesystem + Git CLI + GitHub REST API',
      permissions: ['Read/search local code', 'Inspect git status/commits', 'Query GitHub repos & issues'],
      deeplink: 'https://github.com',
      tokenConfigured: Boolean(process.env.GITHUB_TOKEN || envVars.GITHUB_TOKEN)
    },
    {
      id: 'gmail',
      name: 'Gmail & Email',
      category: 'Google Workspace',
      icon: '✉️',
      connected: true,
      mode: 'Live Gmail API / Mailto Bridge',
      permissions: ['Search real inbox', 'Draft & send emails'],
      deeplink: 'https://mail.google.com',
      tokenConfigured: Boolean(process.env.GMAIL_ACCESS_TOKEN || envVars.GMAIL_ACCESS_TOKEN)
    },
    {
      id: 'google_drive',
      name: 'Google Drive & Workspace Files',
      category: 'Storage',
      icon: '📁',
      connected: true,
      mode: 'Live gdrive CLI + Local Workspace',
      permissions: ['List & search real files', 'Read documents'],
      deeplink: 'https://drive.google.com',
      tokenConfigured: true
    }
  ],
  calendarEvents: [],
  tasks: [],
  notes: [],
  emails: [],
  whatsappLogs: []
};

const FAKE_IDS = new Set([
  'evt-1',
  'evt-2',
  'evt-1793438778612',
  'evt-1793438839147',
  'evt-1793439496021',
  'evt-1793441878678',
  'tsk-1',
  'tsk-2',
  'note-1',
  'note-2',
  'eml-1',
  'eml-2'
]);

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadState() {
  const latestEnv = loadDotEnvVars();
  ensureDataDir();
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(DEFAULT_STATE, null, 2), 'utf8');
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    // Strip any legacy sample/mock items
    const cleanEvents = (parsed.calendarEvents || []).filter(
      (e) => !FAKE_IDS.has(e.id) && e.title !== 'Product Architecture Sync' && e.title !== 'Gym & Evening Run'
    );
    const cleanTasks = (parsed.tasks || []).filter((t) => !FAKE_IDS.has(t.id));
    const cleanNotes = (parsed.notes || []).filter((n) => !FAKE_IDS.has(n.id));
    const cleanEmails = (parsed.emails || []).filter((m) => !FAKE_IDS.has(m.id));

    const mergedOwner = {
      ...DEFAULT_STATE.ownerProfile,
      ...(parsed.ownerProfile || {})
    };
    if (mergedOwner.name === 'Abdul (Owner)') {
      mergedOwner.name = 'Yazeed Abdullah (Yaz)';
    }

    const mergedConfig = {
      ...DEFAULT_STATE.config,
      ...(parsed.config || {})
    };
    if (!mergedConfig.geminiApiKey && (process.env.GEMINI_API_KEY || latestEnv.GEMINI_API_KEY)) {
      mergedConfig.geminiApiKey = process.env.GEMINI_API_KEY || latestEnv.GEMINI_API_KEY;
    }
    if (!mergedConfig.githubToken && (process.env.GITHUB_TOKEN || latestEnv.GITHUB_TOKEN)) {
      mergedConfig.githubToken = process.env.GITHUB_TOKEN || latestEnv.GITHUB_TOKEN;
    }
    if (!mergedConfig.githubUsername && (process.env.GITHUB_USERNAME || latestEnv.GITHUB_USERNAME)) {
      mergedConfig.githubUsername = process.env.GITHUB_USERNAME || latestEnv.GITHUB_USERNAME;
    }

    return {
      ...DEFAULT_STATE,
      ...parsed,
      config: mergedConfig,
      ownerProfile: mergedOwner,
      accounts: DEFAULT_STATE.accounts,
      calendarEvents: cleanEvents,
      tasks: cleanTasks,
      notes: cleanNotes,
      emails: cleanEmails
    };
  } catch (err) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function syncToFirebaseAsync(state) {
  const dbUrl =
    (state.config && state.config.firebaseDatabaseUrl) ||
    'https://rizproject-e6d13-default-rtdb.firebaseio.com';
  const payload = {
    ownerProfile: state.ownerProfile,
    calendarEvents: state.calendarEvents,
    tasks: state.tasks,
    notes: state.notes,
    emails: state.emails,
    updatedAt: new Date().toISOString()
  };
  fetch(`${dbUrl.replace(/\/$/, '')}/riz_state.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), 'utf8');
  syncToFirebaseAsync(state);
  return state;
}

function updateConfig(partialConfig) {
  const state = loadState();
  state.config = { ...state.config, ...partialConfig };
  if (typeof state.config.triggerWords === 'string') {
    state.config.triggerWords = state.config.triggerWords
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  saveState(state);
  return state.config;
}

function updateOwnerProfile(partialProfile) {
  const state = loadState();
  state.ownerProfile = { ...state.ownerProfile, ...partialProfile };
  saveState(state);
  return state.ownerProfile;
}

function addWhatsappLog(entry) {
  const state = loadState();
  const logItem = {
    id: 'wa-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...entry
  };
  state.whatsappLogs.unshift(logItem);
  if (state.whatsappLogs.length > 100) {
    state.whatsappLogs = state.whatsappLogs.slice(0, 100);
  }
  saveState(state);
  return logItem;
}

module.exports = {
  loadState,
  saveState,
  updateConfig,
  updateOwnerProfile,
  addWhatsappLog,
  loadDotEnvVars,
  STORE_PATH
};
