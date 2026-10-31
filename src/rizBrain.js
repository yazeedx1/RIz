const { loadState } = require('./configStore');
const { TOOL_DECLARATIONS, executeTool } = require('./tools');

const INTERACTIONS_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const modelCooldownUntil = new Map();

/**
 * Calls the Gemini Interactions API (`v1beta/interactions`, `Api-Revision: 2026-05-20`)
 * with minimal thinking latency (`generation_config.thinking_level = "minimal"`) and
 * automatic 429/503 cooldown caching for fast sub-3s responses.
 */
async function callGeminiInteractionsApi({ apiKey, model, systemInstruction, userPrompt, previousInteractionId, includeTools = true }) {
  let input = userPrompt;
  let previousId = previousInteractionId || undefined;
  const collectedToolCalls = [];
  const collectedThoughts = [];
  let finalOutputText = '';
  let lastInteractionId = previousId;
  let lockedModel = null;
  let maxTurns = 5;

  while (maxTurns-- > 0) {
    const now = Date.now();
    const rawCandidates = lockedModel
      ? [lockedModel]
      : [
          'gemini-flash-lite-latest',
          'gemini-3.6-flash',
          'gemini-3.5-flash',
          model || 'gemini-3.8-flash',
          'gemma-4-26b-a4b-it'
        ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

    const activeCandidates = rawCandidates.filter((m) => (modelCooldownUntil.get(m) || 0) < now);
    const candidateModels = activeCandidates.length > 0 ? activeCandidates : rawCandidates;

    let interaction = null;
    let activeModel = candidateModels[0];
    let lastErrorText = '';

    for (const candidate of candidateModels) {
      activeModel = candidate;
      const body = {
        model: candidate,
        input,
        system_instruction: systemInstruction
      };
      if (candidate.startsWith('gemini-')) {
        body.generation_config = {
          thinking_level: 'minimal'
        };
      }
      if (includeTools) {
        body.tools = TOOL_DECLARATIONS;
      }
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
        lockedModel = candidate;
        break;
      }

      lastErrorText = await res.text();
      if (res.status === 429 || res.status === 503) {
        // Remember rate limit / high demand for 90 seconds so subsequent messages skip it immediately
        modelCooldownUntil.set(candidate, Date.now() + 90 * 1000);
      }
      if (res.status !== 503 && res.status !== 429 && res.status !== 404) {
        break;
      }
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
        provider: `Gemini Interactions API (${lockedModel || activeModel})`,
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
    provider: `Gemini Interactions API (${lockedModel || 'gemini-flash-lite-latest'})`,
    interactionId: lastInteractionId,
    reply: finalOutputText || 'Completed requested tool actions.',
    thoughts: collectedThoughts,
    toolCalls: collectedToolCalls
  };
}

async function callSingleFastGeminiModel({ apiKey, model, systemInstruction, userPrompt }) {
  const body = {
    model,
    input: userPrompt,
    system_instruction: systemInstruction
  };
  if (model.startsWith('gemini-')) {
    body.generation_config = { thinking_level: 'minimal' };
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
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const interaction = await res.json();
  let text = '';
  if (Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      if (step.type === 'model_output' && Array.isArray(step.content)) {
        for (const block of step.content) {
          if (block.type === 'text' && block.text) text += block.text;
        }
      }
    }
  }
  if (!text && interaction.output_text) text = interaction.output_text;
  if (!text || !text.trim()) throw new Error('Empty output');
  return text.trim();
}

/**
 * Generates a fresh, natural AI response using parallel hedged Gemini Interactions API requests
 * so the fastest model responds in ~1.5–3s without tail-latency stalls.
 */
async function callLiveAiWriter({ systemInstruction, userPrompt }) {
  const state = loadState();
  const apiKey = (state.config && state.config.geminiApiKey) || process.env.GEMINI_API_KEY || '';

  if (apiKey) {
    try {
      const winner = await Promise.any([
        callSingleFastGeminiModel({
          apiKey,
          model: 'gemini-flash-lite-latest',
          systemInstruction,
          userPrompt
        }),
        callSingleFastGeminiModel({
          apiKey,
          model: 'gemma-4-26b-a4b-it',
          systemInstruction,
          userPrompt
        })
      ]);
      if (winner) return winner;
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

  // 3. Git & GitHub queries (matches github, git, repo, repos, rep, rip, repository, push, commits, or any of yazeedx1's repo names)
  if (
    /\b(?:github|git|repo|repos|rep|rip|repository|repositories|commit|commits|branch|push|pull|serbtec|gauntlethub|ssbc|tpnewsite|lebara|vettrack|bino|cst|wadi-jeddah|talemia|wbr|mcit|ssp)\b/i.test(
      userMessage
    )
  ) {
    thoughts.push('Running real Git and GitHub operations via github_and_git_operations.');

    // Check if the user is asking to create a new repository with a specific name
    const createRepoMatch =
      userMessage.match(
        /\b(?:create|make|init|initialize|new)\s+(?:a\s+)?(?:new\s+)?(?:private\s+|public\s+)?(?:github\s+)?(?:repo|rep|rip|repository)\s+(?:on\s+github\s+)?(?:called|named|for|:)?\s*['"]?([a-zA-Z0-9._-]+)['"]?/i
      ) ||
      userMessage.match(
        /\b(?:called|named)\s+['"]?([a-zA-Z0-9._-]+)['"]?\s+(?:on\s+github|repo|rep|rip|repository)/i
      );
    const invalidRepoWords = new Set(['on', 'in', 'github', 'git', 'now', 'for', 'me', 'please', 'private', 'public', 'a', 'the']);
    const candidateRepoName = createRepoMatch && !invalidRepoWords.has(createRepoMatch[1].toLowerCase())
      ? createRepoMatch[1]
      : null;

    if (candidateRepoName && !/^\s*(?:can|could|do|does|is|are)\b/i.test(userMessage)) {
      const isPrivate = /\bprivate\b/i.test(userMessage);
      const createRes = await executeTool('github_and_git_operations', {
        operation: 'github_create_repo',
        usernameOrQuery: candidateRepoName,
        isPrivate
      });
      toolCalls.push({
        name: 'github_and_git_operations',
        arguments: { operation: 'github_create_repo', usernameOrQuery: candidateRepoName, isPrivate },
        result: createRes
      });
    } else if (/\bpush\b/i.test(userMessage) && !/^\s*(?:can|could|do|does)\b/i.test(userMessage)) {
      const pushRes = await executeTool('github_and_git_operations', {
        operation: 'git_push',
        usernameOrQuery: 'Riz live assistant sync via WhatsApp/Chat'
      });
      toolCalls.push({ name: 'github_and_git_operations', arguments: { operation: 'git_push' }, result: pushRes });
    } else {
      const gitStatus = await executeTool('github_and_git_operations', { operation: 'git_status' });
      toolCalls.push({ name: 'github_and_git_operations', arguments: { operation: 'git_status' }, result: gitStatus });
    }

    const ghRepos = await executeTool('github_and_git_operations', {
      operation: 'github_repos'
    });
    toolCalls.push({
      name: 'github_and_git_operations',
      arguments: { operation: 'github_repos' },
      result: ghRepos
    });

    const specificRepoMatch = userMessage.match(
      /\b(RIz|serbtec|gauntlethub|ssbc|tpnewsite|lebara|vettrack|bino|CST|wadi-jeddah|ix|talemia|wbr|MCIT|ssp)\b/i
    );
    const targetRepoName = specificRepoMatch ? `yazeedx1/${specificRepoMatch[1]}` : 'yazeedx1/RIz';
    const repoDetails = await executeTool('github_and_git_operations', {
      operation: 'github_repo_details',
      usernameOrQuery: targetRepoName
    });
    toolCalls.push({
      name: 'github_and_git_operations',
      arguments: { operation: 'github_repo_details', usernameOrQuery: targetRepoName },
      result: repoDetails
    });
  }

  // 3b. Antigravity IDE / Agent / Skills / Plugins / Project Creation queries
  if (/\b(?:antigravity|agy|agent|ide|workspace|plugins?|skills?|mcp|brain)\b/i.test(userMessage)) {
    const createProjMatch =
      userMessage.match(
        /\b(?:create|make|scaffold|init|new)\s+(?:a\s+)?(?:new\s+)?(?:antigravity\s+)?(?:project|folder|workspace|app)\s+(?:on\s+antigravity\s+|in\s+antigravity\s+)?(?:called|named|for|:)?\s*['"]?([a-zA-Z0-9._-]+)['"]?/i
      ) ||
      userMessage.match(
        /\b(?:called|named)\s+['"]?([a-zA-Z0-9._-]+)['"]?\s+(?:on|in)\s+antigravity/i
      );
    const invalidProjWords = new Set(['on', 'in', 'antigravity', 'agy', 'now', 'for', 'me', 'please', 'a', 'the', 'project']);
    const candidateProjName = createProjMatch && !invalidProjWords.has(createProjMatch[1].toLowerCase())
      ? createProjMatch[1]
      : null;

    if (candidateProjName && !/^\s*(?:can|could|do|does|is|are)\b/i.test(userMessage)) {
      thoughts.push(`Creating new Antigravity project "${candidateProjName}" via antigravity_bridge.`);
      const createProjRes = await executeTool('antigravity_bridge', {
        action: 'create_project',
        projectName: candidateProjName,
        syncToGithub: /\bgithub\b/i.test(userMessage)
      });
      toolCalls.push({
        name: 'antigravity_bridge',
        arguments: { action: 'create_project', projectName: candidateProjName },
        result: createProjRes
      });
    } else {
      thoughts.push('Inspecting live Google Antigravity IDE & Agent environment via antigravity_bridge.');
      const agyRes = await executeTool('antigravity_bridge', { action: 'status' });
      toolCalls.push({ name: 'antigravity_bridge', arguments: { action: 'status' }, result: agyRes });
    }
  }

  // 3c. Netlify Cloud Hosting & Deployments queries
  if (/\b(?:netlify|deploys?|deployments?|hosting|sites?|domains?)\b/i.test(userMessage)) {
    const createSiteMatch =
      userMessage.match(
        /\b(?:create|make|new|deploy)\s+(?:a\s+)?(?:new\s+)?(?:netlify\s+)?(?:site|project|app)\s+(?:on\s+netlify\s+|in\s+netlify\s+)?(?:called|named|for|:)?\s*['"]?([a-zA-Z0-9-]+)['"]?/i
      ) ||
      userMessage.match(
        /\b(?:called|named)\s+['"]?([a-zA-Z0-9-]+)['"]?\s+(?:on|in)\s+netlify/i
      );
    const invalidSiteWords = new Set(['on', 'in', 'netlify', 'now', 'for', 'me', 'please', 'a', 'the', 'project', 'site']);
    const candidateSiteName =
      createSiteMatch && !invalidSiteWords.has(createSiteMatch[1].toLowerCase()) ? createSiteMatch[1] : null;

    if (candidateSiteName && !/^\s*(?:can|could|do|does|is|are)\b/i.test(userMessage)) {
      thoughts.push(`Creating new Netlify project/site "${candidateSiteName}" via netlify_operations.`);
      const nCreate = await executeTool('netlify_operations', {
        operation: 'create_site',
        siteNameOrId: candidateSiteName
      });
      toolCalls.push({
        name: 'netlify_operations',
        arguments: { operation: 'create_site', siteNameOrId: candidateSiteName },
        result: nCreate
      });
    } else {
      thoughts.push('Querying live Netlify sites and deployments via netlify_operations.');
      const nSites = await executeTool('netlify_operations', { operation: 'list_sites' });
      toolCalls.push({ name: 'netlify_operations', arguments: { operation: 'list_sites' }, result: nSites });
      if (/\b(?:deploys?|deployments?)\b/i.test(userMessage) && nSites && nSites.netlifyConnected) {
        const nDeploys = await executeTool('netlify_operations', { operation: 'site_deploys' });
        toolCalls.push({ name: 'netlify_operations', arguments: { operation: 'site_deploys' }, result: nDeploys });
      }
    }
  }

  // 3d. Live Voice Call / Phone Call requests (KSA-compatible HTTPS Voice Call Room)
  if (/\b(?:call|calling|phone\s+call|voice\s+call|talk\s+to\s+you|speak\s+with\s+you)\b/i.test(userMessage)) {
    thoughts.push('Generating KSA-compatible HTTPS Live Voice Call Room link via start_live_voice_call.');
    const callRes = await executeTool('start_live_voice_call', {});
    toolCalls.push({ name: 'start_live_voice_call', arguments: {}, result: callRes });
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

  // 5. Calendar / Schedule / Availability queries (handles calendar, calendars, calender, calenders, schedule, etc.)
  if (
    /\b(?:calendars?|calenders?|schedules?|events?|meetings?|agenda|available|availability|free|busy|today|tomorrow|week|appointments?|plans?)\b/i.test(
      userMessage
    ) &&
    !toolCalls.some((t) => t.name === 'create_calendar_event')
  ) {
    if (/\b(?:available|availability|free|busy)\b/i.test(userMessage)) {
      thoughts.push('Checking real calendar availability via check_availability_and_free_slots.');
      const res = await executeTool('check_availability_and_free_slots', {});
      toolCalls.push({ name: 'check_availability_and_free_slots', arguments: {}, result: res });
    }
    thoughts.push('Listing real calendar events across all connected Google Calendar accounts via list_calendar_events.');
    const res = await executeTool('list_calendar_events', {});
    toolCalls.push({ name: 'list_calendar_events', arguments: {}, result: res });
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

  // 9. Location / Owner Profile / Default context (always include 0ms cached calendar events too)
  if (
    toolCalls.length === 0 ||
    /\b(?:where\s+am\s+i|where\s+is|location|about\s+me|who\s+am\s+i|profile|status|working\s+hours)\b/i.test(userMessage)
  ) {
    thoughts.push('Fetching real owner profile & location via get_owner_profile_and_location.');
    const res = await executeTool('get_owner_profile_and_location', {});
    toolCalls.push({ name: 'get_owner_profile_and_location', arguments: {}, result: res });
    if (!toolCalls.some((t) => t.name === 'list_calendar_events')) {
      const calRes = await executeTool('list_calendar_events', {});
      toolCalls.push({ name: 'list_calendar_events', arguments: {}, result: calRes });
    }
  }

  const historyText = (conversationHistory || [])
    .slice(-6)
    .map((h) => `${h.role}: ${h.text}`)
    .join('\n');

  const systemInstruction =
    `You are Riz, the personal AI assistant for ${ownerName}. ` +
    `Write a natural, concise, helpful conversational response directly to "${senderName}" on WhatsApp (1-3 sentences). ` +
    `NEVER use rigid template headers or fake data. Base your answer STRICTLY on the real tool execution results provided below. ` +
    `All of ${ownerName}'s core systems ARE LIVE AND CONNECTED: Google Calendar (yazeedx@gmail.com & yaz@thegauntlet.sa), Gmail (yazeedx@gmail.com & yaz@thegauntlet.sa via XOAUTH2), GitHub (yazeedx1/RIz, all 22 repositories, AND full permission to create new public or private GitHub repositories via github_create_repo and push commits via git_push), and Google Antigravity IDE Bridge (with full permission to create and scaffold new Antigravity workspace projects via antigravity_bridge:create_project).`;

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

  // Stateless keys (AQ.*) execute real tools locally and synthesize via 1-shot Gemini Interactions API
  if (apiKey && !apiKey.startsWith('AQ.')) {
    const contextualPrompt = `[Source: ${source} | Sender: ${sender}]\n${message}`;
    try {
      return await callGeminiInteractionsApi({
        apiKey,
        model,
        systemInstruction,
        userPrompt: contextualPrompt,
        previousInteractionId
      });
    } catch (_) {}
  }

  return await runRealToolAssistedAi(message, sender, conversationHistory);
}

module.exports = {
  processRizMessage,
  callGeminiInteractionsApi,
  generateDynamicSecurityReply
};
