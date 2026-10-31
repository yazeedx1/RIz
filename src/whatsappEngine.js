const { loadState, addWhatsappLog } = require('./configStore');
const { processRizMessage, generateDynamicSecurityReply } = require('./rizBrain');

/**
 * Per-chat session map:
 * key -> {
 *   state: 'locked' | 'awaiting_password' | 'unlocked',
 *   pendingQuestion: string | null,
 *   previousInteractionId: string | null,
 *   history: Array<{ role: string, text: string }>,
 *   updatedAt: number
 * }
 */
const chatSessions = new Map();

function getSessionKey({ chatId, senderPhone, chatName }) {
  return String(chatId || senderPhone || chatName || 'default-chat').toLowerCase().trim();
}

function getOrCreateSession(sessionKey) {
  if (!chatSessions.has(sessionKey)) {
    chatSessions.set(sessionKey, {
      state: 'locked',
      voiceMode: false,
      pendingQuestion: null,
      previousInteractionId: null,
      history: [],
      updatedAt: Date.now()
    });
  }
  return chatSessions.get(sessionKey);
}

function getAllSessions() {
  const list = [];
  for (const [key, val] of chatSessions.entries()) {
    list.push({ chatKey: key, ...val });
  }
  return list;
}

function resetAllSessions() {
  chatSessions.clear();
}

/**
 * Checks whether an incoming WhatsApp message calls the assistant by its name ("Riz").
 */
function detectRizTrigger(messageText, chatType = 'group', config = {}) {
  if (!messageText || typeof messageText !== 'string') {
    return { triggered: false, reason: 'Empty message' };
  }

  if (config.whatsappEnabled === false) {
    return { triggered: false, reason: 'WhatsApp auto-reply is paused in settings' };
  }

  if (chatType === 'group' && config.replyInGroups === false) {
    return { triggered: false, reason: 'Group replies are disabled' };
  }

  if (chatType === 'dm' && config.replyInDMs === false) {
    return { triggered: false, reason: 'Direct message replies are disabled' };
  }

  const triggers = Array.isArray(config.triggerWords) && config.triggerWords.length > 0
    ? config.triggerWords
    : ['Riz'];

  for (const rawTrigger of triggers) {
    const clean = rawTrigger.trim();
    if (!clean) continue;
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|\\b|@)${escaped}(?:\\b|[:,!?]|$)`, 'i');
    if (regex.test(messageText)) {
      return {
        triggered: true,
        matchedTrigger: clean,
        reason: `Matched trigger word "${clean}"`
      };
    }
  }

  if (chatType === 'dm' && config.requireTriggerInDMs === false) {
    return {
      triggered: true,
      matchedTrigger: 'DM-All',
      reason: 'DM auto-reply without trigger word is enabled'
    };
  }

  return {
    triggered: false,
    reason: `Message did not mention "${triggers[0] || 'Riz'}"`
  };
}

/**
 * Strips the trigger phrase ("Hey Riz, ...") to see if the user also included a question.
 */
function extractQuestionAfterTrigger(messageText, matchedTrigger = 'Riz') {
  const escaped = String(matchedTrigger || 'Riz').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cleaned = String(messageText || '')
    .replace(new RegExp(`^(?:hey|hi|hello|yo)?\\s*@?${escaped}[,:.!?\\s]*`, 'i'), '')
    .trim();
  return cleaned.length > 2 ? cleaned : null;
}

/**
 * Sends a WhatsApp message via official Meta WhatsApp Cloud API if configured.
 */
async function sendWhatsAppCloudReply({ phoneId, accessToken, toPhone, text }) {
  if (!phoneId || !accessToken || !toPhone) {
    return { sentViaCloudApi: false };
  }
  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: { body: text }
    })
  });
  const data = await res.json();
  return { sentViaCloudApi: res.ok, response: data };
}

/**
 * Processes an incoming WhatsApp message with 3-stage state machine where EVERY reply
 * is written dynamically by the AI (never a hardcoded standard script):
 * 1. Locked -> Trigger "Riz" -> AI asks for password ("blacky")
 * 2. Awaiting Password -> Verify "blacky" -> AI welcomes caller into Open Conversation Mode
 * 3. Unlocked -> Open Conversation Mode (AI answers any question using real Calendar, Codebase, GitHub, Email, Location tools)
 */
async function handleIncomingWhatsAppMessage({
  chatId = '',
  senderName = 'Contact',
  senderPhone = '+15550192834',
  chatName = 'Friends Group',
  chatType = 'group',
  messageText = '',
  isVoiceMessage = false
}) {
  const state = loadState();
  const config = state.config || {};
  const ownerName = (state.ownerProfile && state.ownerProfile.name) || 'Yazeed Abdullah (Yaz)';
  const password = String(config.accessPassword || 'blacky').trim().toLowerCase();
  const requirePassword = config.requirePasswordForOpenChat !== false;

  const sessionKey = getSessionKey({ chatId, senderPhone, chatName });
  const session = getOrCreateSession(sessionKey);
  const textTrimmed = String(messageText || '').trim();
  const textLower = textTrimmed.toLowerCase();

  // Check if user toggled voice mode on or off
  if (/\b(?:voice\s+mode\s+on|enable\s+voice|switch\s+to\s+voice|voice\s+chat\s+on)\b/i.test(textTrimmed)) {
    session.voiceMode = true;
  } else if (/\b(?:voice\s+mode\s+off|disable\s+voice|text\s+only|text\s+mode)\b/i.test(textTrimmed)) {
    session.voiceMode = false;
  }

  const wantsVoiceThisTurn =
    Boolean(isVoiceMessage) ||
    Boolean(session.voiceMode) ||
    /\b(?:voice\s+note|voice\s+message|reply\s+(?:with|by|in)\s+voice|send\s+(?:a\s+)?voice|speak\s+to\s+me)\b/i.test(
      textTrimmed
    );

  const cleanDigits = (senderPhone || '').replace(/[^\d]/g, '');
  const makeWaLink = (replyText) =>
    cleanDigits
      ? `https://wa.me/${cleanDigits}?text=${encodeURIComponent(replyText)}`
      : `https://wa.me/?text=${encodeURIComponent(replyText)}`;

  // Check if user wants to lock/end an unlocked or awaiting_password session
  if (
    session.state !== 'locked' &&
    /^(?:lock|logout|exit|bye\s+riz|stop\s+riz|close\s+session)\b/i.test(textTrimmed)
  ) {
    session.state = 'locked';
    session.pendingQuestion = null;
    session.previousInteractionId = null;
    session.history = [];
    session.updatedAt = Date.now();

    const lockReply = await generateDynamicSecurityReply({
      eventType: 'session_locked',
      senderName,
      ownerName
    });
    const logEntry = addWhatsappLog({
      senderName,
      senderPhone,
      chatName,
      chatType,
      incomingMessage: messageText,
      triggered: true,
      matchedTrigger: 'Session Lock Command',
      reason: 'User locked open conversation session',
      reply: lockReply,
      provider: 'Riz Live AI',
      toolCalls: [],
      waDeepLink: makeWaLink(lockReply)
    });
    return {
      triggered: true,
      sessionState: session.state,
      sendVoiceReply: wantsVoiceThisTurn,
      reply: lockReply,
      waDeepLink: makeWaLink(lockReply),
      log: logEntry
    };
  }

  // =========================================================================
  // STAGE 2: AWAITING PASSWORD ("blacky")
  // =========================================================================
  if (session.state === 'awaiting_password') {
    const escapedPwd = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pwdRegex = new RegExp(`(?:^|\\b)${escapedPwd}(?:\\b|[!.?,]|$)`, 'i');

    if (pwdRegex.test(textTrimmed)) {
      session.state = 'unlocked';
      session.updatedAt = Date.now();

      const remainderAfterPwd = textTrimmed
        .replace(new RegExp(`^(?:password\\s+is\\s+|it's\\s+|it\\s+is\\s+)?${escapedPwd}[,:.!?\\s]*`, 'i'), '')
        .trim();
      const questionToRun = remainderAfterPwd || session.pendingQuestion;
      session.pendingQuestion = null;

      let replyText = '';
      let toolCalls = [];
      let provider = 'Riz Live AI (Unlocked)';

      if (questionToRun) {
        const aiResult = await processRizMessage({
          message: questionToRun,
          sender: senderName,
          source: `whatsapp-${chatType}`,
          previousInteractionId: session.previousInteractionId,
          conversationHistory: session.history
        });
        session.previousInteractionId = aiResult.interactionId || null;
        session.history.push({ role: senderName, text: questionToRun });
        session.history.push({ role: 'Riz', text: aiResult.reply });
        replyText = aiResult.reply;
        toolCalls = aiResult.toolCalls || [];
        provider = aiResult.provider;
      } else {
        replyText = await generateDynamicSecurityReply({
          eventType: 'password_verified',
          senderName,
          ownerName
        });
      }

      const logEntry = addWhatsappLog({
        senderName,
        senderPhone,
        chatName,
        chatType,
        incomingMessage: messageText,
        triggered: true,
        matchedTrigger: 'Password Verified ("blacky")',
        reason: 'Unlocked Open Conversation Mode',
        reply: replyText,
        provider,
        toolCalls,
        waDeepLink: makeWaLink(replyText)
      });

      return {
        triggered: true,
        sessionState: session.state,
        sendVoiceReply: wantsVoiceThisTurn,
        matchedTrigger: 'Password Verified',
        reply: replyText,
        provider,
        toolCalls,
        waDeepLink: makeWaLink(replyText),
        log: logEntry
      };
    }

    if (textLower === 'cancel') {
      session.state = 'locked';
      session.pendingQuestion = null;
      const cancelReply = await generateDynamicSecurityReply({
        eventType: 'session_locked',
        senderName,
        ownerName
      });
      const logEntry = addWhatsappLog({
        senderName,
        senderPhone,
        chatName,
        chatType,
        incomingMessage: messageText,
        triggered: true,
        matchedTrigger: 'Cancel Password',
        reason: 'Cancelled password prompt',
        reply: cancelReply,
        provider: 'Riz Live AI',
        toolCalls: []
      });
      return {
        triggered: true,
        sessionState: session.state,
        sendVoiceReply: wantsVoiceThisTurn,
        reply: cancelReply,
        waDeepLink: makeWaLink(cancelReply),
        log: logEntry
      };
    }

    const wrongPwdReply = await generateDynamicSecurityReply({
      eventType: 'wrong_password',
      senderName,
      ownerName,
      extraContext: textTrimmed
    });
    const logEntry = addWhatsappLog({
      senderName,
      senderPhone,
      chatName,
      chatType,
      incomingMessage: messageText,
      triggered: true,
      matchedTrigger: 'Password Prompt',
      reason: 'Incorrect password attempt',
      reply: wrongPwdReply,
      provider: 'Riz Live AI',
      toolCalls: []
    });
    return {
      triggered: true,
      sessionState: session.state,
      sendVoiceReply: wantsVoiceThisTurn,
      reply: wrongPwdReply,
      waDeepLink: makeWaLink(wrongPwdReply),
      log: logEntry
    };
  }

  // =========================================================================
  // STAGE 3: UNLOCKED (OPEN CONVERSATION MODE — NO TRIGGER WORD REQUIRED)
  // =========================================================================
  if (session.state === 'unlocked') {
    session.updatedAt = Date.now();
    const aiResult = await processRizMessage({
      message: textTrimmed,
      sender: senderName,
      source: `whatsapp-${chatType}`,
      previousInteractionId: session.previousInteractionId,
      conversationHistory: session.history
    });

    session.previousInteractionId = aiResult.interactionId || null;
    session.history.push({ role: senderName, text: textTrimmed });
    session.history.push({ role: 'Riz', text: aiResult.reply });
    if (session.history.length > 20) {
      session.history = session.history.slice(-20);
    }

    let cloudDelivery = { sentViaCloudApi: false };
    if (config.whatsappPhoneId && config.whatsappAccessToken && senderPhone) {
      try {
        cloudDelivery = await sendWhatsAppCloudReply({
          phoneId: config.whatsappPhoneId,
          accessToken: config.whatsappAccessToken,
          toPhone: senderPhone,
          text: aiResult.reply
        });
      } catch (err) {
        cloudDelivery = { sentViaCloudApi: false, error: err.message };
      }
    }

    const waDeepLink = makeWaLink(aiResult.reply);
    const logEntry = addWhatsappLog({
      senderName,
      senderPhone,
      chatName,
      chatType,
      incomingMessage: messageText,
      triggered: true,
      matchedTrigger: 'Open Conversation (Unlocked)',
      reason: 'Session unlocked with "blacky" — open conversation active',
      reply: aiResult.reply,
      provider: aiResult.provider,
      thoughts: aiResult.thoughts || [],
      toolCalls: aiResult.toolCalls || [],
      waDeepLink,
      cloudDelivery
    });

    return {
      triggered: true,
      sessionState: session.state,
      sendVoiceReply: wantsVoiceThisTurn,
      matchedTrigger: 'Open Conversation',
      reply: aiResult.reply,
      provider: aiResult.provider,
      thoughts: aiResult.thoughts || [],
      toolCalls: aiResult.toolCalls || [],
      waDeepLink,
      log: logEntry
    };
  }

  // =========================================================================
  // STAGE 1: LOCKED — CHECK FOR "RIZ" TRIGGER
  // =========================================================================
  const triggerCheck = detectRizTrigger(messageText, chatType, config);

  if (!triggerCheck.triggered) {
    const skippedLog = addWhatsappLog({
      senderName,
      senderPhone,
      chatName,
      chatType,
      incomingMessage: messageText,
      triggered: false,
      reason: triggerCheck.reason,
      reply: null,
      toolCalls: []
    });
    return {
      triggered: false,
      sessionState: session.state,
      reason: triggerCheck.reason,
      log: skippedLog
    };
  }

  // Triggered! Check if password gate is enabled
  if (requirePassword && password) {
    const escapedPwd = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pwdRegex = new RegExp(`(?:^|\\b)${escapedPwd}(?:\\b|[!.?,]|$)`, 'i');

    // If the user included "blacky" in the initial trigger message itself
    if (pwdRegex.test(textTrimmed)) {
      session.state = 'unlocked';
      session.updatedAt = Date.now();
      const questionPart = extractQuestionAfterTrigger(textTrimmed, triggerCheck.matchedTrigger);
      const cleanQuestion = questionPart
        ? questionPart.replace(pwdRegex, '').trim()
        : '';

      if (cleanQuestion) {
        const aiResult = await processRizMessage({
          message: cleanQuestion,
          sender: senderName,
          source: `whatsapp-${chatType}`,
          previousInteractionId: session.previousInteractionId,
          conversationHistory: session.history
        });
        session.previousInteractionId = aiResult.interactionId || null;
        session.history.push({ role: senderName, text: cleanQuestion });
        session.history.push({ role: 'Riz', text: aiResult.reply });
        const replyText = aiResult.reply;
        const logEntry = addWhatsappLog({
          senderName,
          senderPhone,
          chatName,
          chatType,
          incomingMessage: messageText,
          triggered: true,
          matchedTrigger: `${triggerCheck.matchedTrigger} + Password`,
          reason: 'Triggered and unlocked in one message',
          reply: replyText,
          provider: aiResult.provider,
          toolCalls: aiResult.toolCalls || [],
          waDeepLink: makeWaLink(replyText)
        });
        return {
          triggered: true,
          sessionState: session.state,
          sendVoiceReply: wantsVoiceThisTurn,
          matchedTrigger: triggerCheck.matchedTrigger,
          reply: replyText,
          provider: aiResult.provider,
          toolCalls: aiResult.toolCalls || [],
          waDeepLink: makeWaLink(replyText),
          log: logEntry
        };
      }
    }

    // Move session to awaiting_password and ask for password dynamically via AI!
    session.state = 'awaiting_password';
    session.pendingQuestion = extractQuestionAfterTrigger(textTrimmed, triggerCheck.matchedTrigger);
    session.updatedAt = Date.now();

    const promptReply = await generateDynamicSecurityReply({
      eventType: 'ask_password',
      senderName,
      ownerName
    });
    const logEntry = addWhatsappLog({
      senderName,
      senderPhone,
      chatName,
      chatType,
      incomingMessage: messageText,
      triggered: true,
      matchedTrigger: triggerCheck.matchedTrigger,
      reason: 'Triggered "Riz" -> AI prompted for password',
      reply: promptReply,
      provider: 'Riz Live AI',
      toolCalls: [],
      waDeepLink: makeWaLink(promptReply)
    });

    return {
      triggered: true,
      sessionState: session.state,
      sendVoiceReply: wantsVoiceThisTurn,
      matchedTrigger: triggerCheck.matchedTrigger,
      reply: promptReply,
      provider: 'Riz Live AI',
      toolCalls: [],
      waDeepLink: makeWaLink(promptReply),
      log: logEntry
    };
  }

  // Fallback if password gate is turned off in settings
  const aiResult = await processRizMessage({
    message: messageText,
    sender: senderName,
    source: `whatsapp-${chatType}`
  });

  const waDeepLink = makeWaLink(aiResult.reply);
  const logEntry = addWhatsappLog({
    senderName,
    senderPhone,
    chatName,
    chatType,
    incomingMessage: messageText,
    triggered: true,
    matchedTrigger: triggerCheck.matchedTrigger,
    reason: triggerCheck.reason,
    reply: aiResult.reply,
    provider: aiResult.provider,
    thoughts: aiResult.thoughts || [],
    toolCalls: aiResult.toolCalls || [],
    waDeepLink
  });

  return {
    triggered: true,
    sessionState: session.state,
    sendVoiceReply: wantsVoiceThisTurn,
    matchedTrigger: triggerCheck.matchedTrigger,
    reply: aiResult.reply,
    provider: aiResult.provider,
    thoughts: aiResult.thoughts || [],
    toolCalls: aiResult.toolCalls || [],
    waDeepLink,
    log: logEntry
  };
}

module.exports = {
  detectRizTrigger,
  handleIncomingWhatsAppMessage,
  getAllSessions,
  resetAllSessions
};
