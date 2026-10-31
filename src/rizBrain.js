const { loadState } = require('./configStore');
const { TOOL_DECLARATIONS, executeTool } = require('./tools');

const INTERACTIONS_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * Calls the Gemini Interactions API (`v1beta/interactions`, `Api-Revision: 2026-05-20`)
 * with stateful multi-turn function calling (`previous_interaction_id` + `function_result` steps).
 */
async function callGeminiInteractionsApi({ apiKey, model, systemInstruction, userPrompt, previousInteractionId }) {
  let input = userPrompt;
  let previousId = previousInteractionId || undefined;
  const collectedToolCalls = [];
  const collectedThoughts = [];
  let finalOutputText = '';
  let lastInteractionId = previousId;
  let maxTurns = 5;

  while (maxTurns-- > 0) {
    const candidateModels = [
      model || 'gemini-3.8-flash',
      'gemini-flash-lite-latest',
      'gemma-4-26b-a4b-it'
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

    let interaction = null;
    let activeModel = candidateModels[0];
    let lastErrorText = '';

    for (const candidate of candidateModels) {
      activeModel = candidate;
      const body = {
        model: candidate,
        input,
        system_instruction: systemInstruction,
        tools: TOOL_DECLARATIONS
      };
      if (previousId) {
        body.previous_interaction_id = previousId;
      }

      const res = await fetch(INTERACTIONS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Api-Revision': '2026-05-20'
        },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        interaction = await res.json();
        model = activeModel;
        break;
      }

      lastErrorText = await res.text();
      if (res.status !== 503 && res.status !== 429) {
        break;
      }
      // If 503/429 and previousId was tied to another model, clear previousId for fallback model
      previousId = undefined;
    }

    if (!interaction) {
      throw new Error(`Gemini Interactions API error: ${lastErrorText}`);
    }

    lastInteractionId = interaction.id;
    const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
    const functionResults = [];

    for (const step of steps) {
      if (step.type === 'thought' && Array.isArray(step.summary)) {
        for (const s of step.summary) {
          if (s.text) collectedThoughts.push(s.text);
        }
      } else if (step.type === 'function_call') {
        const args = step.arguments || {};
        const toolResult = await executeTool(step.name, args);
        collectedToolCalls.push({
          id: step.id,
          name: step.name,
          arguments: args,
          result: toolResult
        });
        functionResults.push({
          type: 'function_result',
          name: step.name,
          call_id: step.id,
          result: [{ type: 'text', text: JSON.stringify(toolResult) }]
        });
      } else if (step.type === 'model_output' && Array.isArray(step.content)) {
        for (const block of step.content) {
          if (block.type === 'text' && block.text) {
            finalOutputText += block.text;
          }
        }
      }
    }

    if (interaction.output_text && !finalOutputText) {
      finalOutputText = interaction.output_text;
    }

    if (functionResults.length === 0) {
      return {
        provider: `Gemini Interactions API (${model || 'gemini-3.8-flash'})`,
        interactionId: lastInteractionId,
        reply: finalOutputText || 'Done!',
        thoughts: collectedThoughts,
        toolCalls: collectedToolCalls
      };
    }

    input = functionResults;
    previousId = interaction.id;
    finalOutputText = '';
  }

  return {
    provider: `Gemini Interactions API (${model || 'gemini-3.8-flash'})`,
    interactionId: lastInteractionId,
    reply: finalOutputText || 'Completed requested tool actions.',
    thoughts: collectedThoughts,
    toolCalls: collectedToolCalls
  };
}

/**
 * Generates a fresh, natural AI response using Gemini (if GEMINI_API_KEY is set)
 * or live OpenAI-compatible AI completion so Riz never repeats a rigid standard script.
 */
async function callLiveAiWriter({ systemInstruction, userPrompt }) {
  const state = loadState();
  const apiKey = (state.config && state.config.geminiApiKey) || process.env.GEMINI_API_KEY || '';

  if (apiKey) {
    try {
      const res = await callGeminiInteractionsApi({
        apiKey,
        model: (state.config && state.config.model) || 'gemini-3.8-flash',
        systemInstruction,
        userPrompt
      });
      if (res && res.reply) return res.reply.trim();
    } catch (_) {}
  }

  try {
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        seed: Math.floor(Math.random() * 1000000),
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt }
        ]
      })
    });
    if (res.ok) {
      const data = await res.json();
      const text =
        data &&
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content;
      if (text && !text.includes('Free limit reached')) {
        return text.trim();
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Dynamically generates the security gate replies (asking for password, welcoming after password,
 * wrong password, or locking session) using the AI so it is written freshly each time.
 */
async function generateDynamicSecurityReply({ eventType, senderName = 'there', ownerName = 'Yazeed', extraContext = '' }) {
  const systemInstruction =
    `You are Riz, ${ownerName}'s personal AI assistant on WhatsApp. ` +
    `Write a natural, warm, concise 1-to-2 sentence WhatsApp message in your own words. ` +
    `Never use bullet-point menus or robotic canned scripts. Do not reveal the password yourself.`;

  const promptsByEvent = {
    ask_password: `The user "${senderName}" just called your name ("Riz") on WhatsApp. Greet ${senderName} naturally as Riz (${ownerName}'s AI assistant) and ask them to reply with the secret password before you can open the conversation.${extraContext ? ' Note: ' + extraContext : ''}`,
    password_verified: `The user "${senderName}" just entered the correct password and unlocked Open Conversation Mode. Welcome ${senderName} naturally in 1-2 sentences and let them know they can now chat with you freely about ${ownerName}'s schedule, availability, location, codebase, GitHub, or emails without needing to say "Riz" each time.`,
    wrong_password: `The user "${senderName}" tried to unlock you on WhatsApp, but entered the wrong password ("${extraContext}"). Politely and naturally tell ${senderName} in 1 short sentence that the password isn't right and ask them to try again.`,
    session_locked: `The user "${senderName}" asked to lock/close the session. Confirm naturally in 1 short sentence that the chat is now locked and they can call "Riz" anytime they need you again.`
  };

  const aiReply = await callLiveAiWriter({
    systemInstruction,
    userPrompt: promptsByEvent[eventType] || promptsByEvent.ask_password
  });

  if (aiReply) {
    return aiReply;
  }

  // Varied natural conversational phrasing if offline or rate-limited
  const r = Math.floor(Math.random() * 4);
  if (eventType === 'ask_password') {
    const variations = [
      `Hey ${senderName}! I'm Riz, ${ownerName}'s AI assistant. What's the secret password so we can chat?`,
      `Hi ${senderName}, Riz here! Drop the access password and I'll be happy to help you with anything you need.`,
      `Hello ${senderName}! Before I can share ${ownerName}'s info or open our chat, please send me the password.`,
      `Hey there ${senderName}! I'm Riz. Just reply with the password and we can talk freely.`
    ];
    return variations[r];
  }
  if (eventType === 'password_verified') {
    const variations = [
      `You're in, ${senderName}! Feel free to ask me anything about ${ownerName}'s schedule, location, code, GitHub, or emails—no need to say "Riz" anymore.`,
      `That's the right password, ${senderName}! Our chat is now open—what would you like to know or do?`,
      `Unlocked! Good to talk with you, ${senderName}. Ask away about ${ownerName}'s calendar, availability, projects, or anything else.`,
      `Got it, ${senderName}! We're in open conversation mode now—how can I help you today?`
    ];
    return variations[r];
  }
  if (eventType === 'wrong_password') {
    const variations = [
      `Hmm, "${extraContext}" isn't the right password, ${senderName}—give it another try!`,
      `That password didn't match, ${senderName}. Try sending the password again (or say "cancel" to stop).`,
      `Not quite the right code, ${senderName}! Please reply with the correct password to unlock me.`,
      `Oops, wrong password! Send the right one whenever you're ready, ${senderName}.`
    ];
    return variations[r];
  }
  return `All locked up, ${senderName}! Just say "Riz" whenever you want to chat again.`;
}

/**
 * Executes real tools based on the user's request and asks the AI model to write
 * a natural response grounded in the real tool results.
 */
async function runRealToolAssistedAi(userMessage, senderName = 'User', conversationHistory = []) {
  const lower = userMessage.toLowerCase();
  const toolCalls = [];
  const thoughts = [];
  const state = loadState();
  const ownerName = (state.ownerProfile && state.ownerProfile.name) || 'Yazeed Abdullah (Yaz)';

  // 1. Update location or status ("I am at ...", "update my location to ...")
  const locUpdateMatch = userMessage.match(
    /\b(?:update\s+(?:my\s+)?location\s+to|i\s+am\s+(?:currently\s+)?at|set\s+(?:my\s+)?location\s+to)\s+(.+)/i
  );
  if (locUpdateMatch) {
    const newLoc = locUpdateMatch[1].trim();
    thoughts.push(`Updating owner location to "${newLoc}" via update_owner_location_or_status.`);
    const res = await executeTool('update_owner_location_or_status', { currentLocation: newLoc });
    toolCalls.push({ name: 'update_owner_location_or_status', arguments: { currentLocation: newLoc }, result: res });
  }

  // 2. Codebase / source code / files inspection
  if (
    /\b(?:code|codes|codebase|file|files|folder|directory|project|projects|script|source|repo)\b/i.test(userMessage) &&
    !/\bgithub\b/i.test(userMessage)
  ) {
    thoughts.push('Inspecting real local codebase and workspace files via inspect_codebase_and_files.');
    const rootList = await executeTool('inspect_codebase_and_files', { action: 'list', targetPath: 'riz-assistant/src' });
    toolCalls.push({
      name: 'inspect_codebase_and_files',
      arguments: { action: 'list', targetPath: 'riz-assistant/src' },
      result: rootList
    });
    const wsList = await executeTool('list_workspace_files', {});
    toolCalls.push({ name: 'list_workspace_files', arguments: {}, result: wsList });
  }

  // 3. Git & GitHub queries
  if (/\b(?:github|git|commit|commits|branch|pull\s+request|issue|issues|repositories|repos)\b/i.test(userMessage)) {
    thoughts.push('Running real Git and GitHub operations via github_and_git_operations.');
    const gitStatus = await executeTool('github_and_git_operations', { operation: 'git_status' });
    toolCalls.push({ name: 'github_and_git_operations', arguments: { operation: 'git_status' }, result: gitStatus });

    const userMatch = userMessage.match(/\b(?:github\.com\/|user\s+|username\s+)([a-zA-Z0-9-]+)\b/i);
    const ghRepos = await executeTool('github_and_git_operations', {
      operation: 'github_repos',
      usernameOrQuery: userMatch ? userMatch[1] : undefined
    });
    toolCalls.push({
      name: 'github_and_git_operations',
      arguments: { operation: 'github_repos', usernameOrQuery: userMatch ? userMatch[1] : undefined },
      result: ghRepos
    });
  }

  // 4. Calendar creation intent
  if (
    /\b(?:schedule\s+a|schedule\s+an|add\s+a|add\s+event|add\s+meeting|create\s+a|book\s+a|set\s+a\s+meeting)\b/i.test(
      userMessage
    ) ||
    (/\b(?:meeting|appointment|event)\b/i.test(userMessage) && /\bat\s+\d{1,2}/i.test(userMessage))
  ) {
    const timeMatch = userMessage.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    let time = '15:00';
    if (timeMatch) {
      let hr = parseInt(timeMatch[1], 10);
      const min = timeMatch[2] || '00';
      const mer = (timeMatch[3] || '').toLowerCase();
      if (mer === 'pm' && hr < 12) hr += 12;
      if (mer === 'am' && hr === 12) hr = 0;
      time = `${String(hr).padStart(2, '0')}:${min}`;
    }
    const cleanTitle =
      userMessage
        .replace(/\b(hey|hi|hello)?\s*riz[:,!]?\s*/i, '')
        .replace(/\b(please\s+)?(schedule|add|create|book)\s+(a\s+)?(meeting|event|call|appointment)?\s*/i, '')
        .trim() || 'Meeting scheduled via WhatsApp';

    thoughts.push(`Scheduling real calendar event "${cleanTitle}" at ${time}.`);
    const res = await executeTool('create_calendar_event', {
      title: cleanTitle,
      time,
      durationMinutes: 30,
      location: 'Google Calendar'
    });
    toolCalls.push({ name: 'create_calendar_event', arguments: { title: cleanTitle, time }, result: res });
  }

  // 5. Calendar / Schedule / Availability queries
  if (
    /\b(?:calendar|schedule|events|meetings|agenda|available|availability|free|busy)\b/i.test(userMessage) &&
    !toolCalls.some((t) => t.name === 'create_calendar_event')
  ) {
    if (/\b(?:available|availability|free|busy)\b/i.test(userMessage)) {
      thoughts.push('Checking real calendar availability via check_availability_and_free_slots.');
      const res = await executeTool('check_availability_and_free_slots', {});
      toolCalls.push({ name: 'check_availability_and_free_slots', arguments: {}, result: res });
    } else {
      thoughts.push('Listing real calendar events via list_calendar_events.');
      const res = await executeTool('list_calendar_events', {});
      toolCalls.push({ name: 'list_calendar_events', arguments: {}, result: res });
    }
  }

  // 6. Email queries
  if (/\b(?:email|emails|gmail|inbox|mail|unread)\b/i.test(userMessage)) {
    const emailMatch = userMessage.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (/\b(?:send|draft|write|compose)\b/i.test(userMessage) && emailMatch) {
      const to = emailMatch[0];
      const res = await executeTool('send_or_draft_email', {
        to,
        subject: `Message from ${ownerName} via Riz`,
        body: userMessage
      });
      toolCalls.push({ name: 'send_or_draft_email', arguments: { to }, result: res });
    } else {
      thoughts.push('Searching real email state via search_emails.');
      const res = await executeTool('search_emails', { query: lower.includes('unread') ? 'unread' : '' });
      toolCalls.push({ name: 'search_emails', arguments: {}, result: res });
    }
  }

  // 7. Task / Note creation or listing
  if (/\b(?:remind\s+me|add\s+task|new\s+task|todo|save\s+note|remember\s+that)\b/i.test(userMessage)) {
    const isNote = /\b(?:note|remember\s+that)\b/i.test(userMessage);
    const cleanText =
      userMessage
        .replace(/\b(hey|hi|hello)?\s*riz[:,!]?\s*/i, '')
        .replace(/\b(please\s+)?(remind\s+me\s+to|add\s+task|create\s+task|save\s+note|remember\s+that)\s*/i, '')
        .trim() || userMessage;
    const res = await executeTool('create_task_or_note', {
      itemType: isNote ? 'note' : 'task',
      title: cleanText,
      content: isNote ? cleanText : 'high'
    });
    toolCalls.push({ name: 'create_task_or_note', arguments: { itemType: isNote ? 'note' : 'task', title: cleanText }, result: res });
  } else if (/\b(?:tasks|todos|reminders|notes|wifi|pin)\b/i.test(userMessage)) {
    const res = await executeTool('list_tasks_and_notes', {});
    toolCalls.push({ name: 'list_tasks_and_notes', arguments: {}, result: res });
  }

  // 8. App launch queries
  const appMatch = lower.match(/\b(?:open|launch|play\s+on|start)\s+(whatsapp|spotify|gmail|google\s+calendar|calendar|google\s+drive|drive|youtube|google\s+maps|maps|github)\b/i);
  if (appMatch) {
    const appName = appMatch[1];
    const res = await executeTool('open_app_or_deeplink', { appName, actionOrQuery: '' });
    toolCalls.push({ name: 'open_app_or_deeplink', arguments: { appName }, result: res });
  }

  // 9. Location / Owner Profile / Default context
  if (
    toolCalls.length === 0 ||
    /\b(?:where\s+am\s+i|where\s+is|location|about\s+me|who\s+am\s+i|profile|status|working\s+hours)\b/i.test(userMessage)
  ) {
    thoughts.push('Fetching real owner profile & location via get_owner_profile_and_location.');
    const res = await executeTool('get_owner_profile_and_location', {});
    toolCalls.push({ name: 'get_owner_profile_and_location', arguments: {}, result: res });
  }

  const historyText = (conversationHistory || [])
    .slice(-6)
    .map((h) => `${h.role}: ${h.text}`)
    .join('\n');

  const systemInstruction =
    `You are Riz, the personal AI assistant for ${ownerName}. ` +
    `Write a natural, helpful, conversational response directly to "${senderName}" on WhatsApp. ` +
    `NEVER use rigid template headers or fake data. Base your answer STRICTLY on the real tool execution results provided below. ` +
    `If a tool shows 0 events, 0 emails, or that an account (like Google Calendar OAuth or GitHub token) needs one-time sign-in, explain that naturally and honestly.`;

  const userPrompt =
    (historyText ? `Recent chat history:\n${historyText}\n\n` : '') +
    `Caller (${senderName}): "${userMessage}"\n\n` +
    `Real Live Tool Results (JSON):\n${JSON.stringify(toolCalls.map((t) => ({ tool: t.name, result: t.result })), null, 2)}\n\n` +
    `Write your natural WhatsApp response as Riz:`;

  const liveAiReply = await callLiveAiWriter({ systemInstruction, userPrompt });
  if (liveAiReply) {
    return {
      provider: 'Riz Live AI + Real Tools',
      reply: liveAiReply,
      thoughts,
      toolCalls
    };
  }

  // Honest, natural synthesis of real tool results if offline
  const primary = toolCalls[0];
  let naturalSynthesis = `Here's what I found from ${ownerName}'s live system: `;
  if (primary && primary.name === 'check_availability_and_free_slots') {
    const r = primary.result;
    const busy = r.busyBlocks.length
      ? `busy during ${r.busyBlocks.map((b) => `${b.start}–${b.end} (${b.title})`).join(', ')}`
      : 'no meetings scheduled on the calendar right now';
    naturalSynthesis = `${ownerName} currently has ${busy} for ${r.date} (free windows: ${r.freeWindows.join(', ')}).${
      r.googleCalendarAuthNote ? ` Note: ${r.googleCalendarAuthNote}` : ''
    }`;
  } else if (primary && primary.name === 'list_calendar_events') {
    const r = primary.result;
    naturalSynthesis = r.events.length
      ? `On the calendar: ${r.events.map((e) => `${e.title} on ${e.date} at ${e.time}`).join('; ')}.`
      : `There are currently no scheduled events on the calendar.${r.googleCalendarAuthNote ? ` (${r.googleCalendarAuthNote})` : ''}`;
  } else if (primary && primary.name === 'create_calendar_event') {
    const r = primary.result;
    naturalSynthesis = `Done! I've scheduled "${r.event.title}" for ${r.event.date} at ${r.event.time} (${r.googleCalendarLink}).`;
  } else if (primary && primary.name === 'inspect_codebase_and_files') {
    const r = primary.result;
    const files = (r.entries || []).map((e) => e.name).join(', ');
    naturalSynthesis = `In your codebase (${r.directory}), the active files are: ${files}.`;
  } else if (primary && primary.name === 'github_and_git_operations') {
    const r = primary.result;
    naturalSynthesis = r.repositories
      ? `Found ${r.repositories.length} GitHub repositories: ${r.repositories.map((repo) => repo.name).join(', ')}.`
      : r.output || r.message || 'Checked Git/GitHub status.';
  } else if (primary && primary.name === 'search_emails') {
    const r = primary.result;
    naturalSynthesis = r.emails && r.emails.length
      ? `Found ${r.emails.length} email(s): ${r.emails.map((e) => `"${e.subject}" from ${e.from}`).join(', ')}.`
      : r.note || 'No matching emails found.';
  } else if (primary && primary.name === 'get_owner_profile_and_location') {
    const p = primary.result.ownerProfile;
    naturalSynthesis = `${p.name} is currently in ${p.currentLocation} (${p.currentStatus}). Working hours are ${p.workingHours} (${p.timezone}).`;
  } else {
    naturalSynthesis = JSON.stringify(primary ? primary.result : {});
  }

  return {
    provider: 'Riz Real Tool Engine',
    reply: naturalSynthesis,
    thoughts,
    toolCalls
  };
}

/**
 * Main entry point to process a message sent to Riz.
 */
async function processRizMessage({ message, sender = 'User', source = 'chat', previousInteractionId = null, conversationHistory = [] }) {
  const state = loadState();
  const apiKey = (state.config && state.config.geminiApiKey) || process.env.GEMINI_API_KEY || '';
  const model = (state.config && state.config.model) || 'gemini-3.8-flash';
  const systemInstruction =
    (state.config && state.config.systemInstruction) ||
    'You are Riz, the personal AI assistant for Yazeed Abdullah (Yaz). Write every response naturally and use real tools.';

  const contextualPrompt = `[Source: ${source} | Sender: ${sender}]\n${message}`;

  if (apiKey) {
    try {
      return await callGeminiInteractionsApi({
        apiKey,
        model,
        systemInstruction,
        userPrompt: contextualPrompt,
        previousInteractionId
      });
    } catch (err) {
      const fallback = await runRealToolAssistedAi(message, sender, conversationHistory);
      fallback.provider = `${fallback.provider} (Gemini API note: ${err.message.slice(0, 80)})`;
      return fallback;
    }
  }

  return await runRealToolAssistedAi(message, sender, conversationHistory);
}

module.exports = {
  processRizMessage,
  callGeminiInteractionsApi,
  generateDynamicSecurityReply
};
