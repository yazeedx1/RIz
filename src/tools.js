const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { loadState, saveState, loadDotEnvVars } = require('./configStore');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const GCALENDAR_SCRIPT = path.join(
  WORKSPACE_ROOT,
  '.gemini',
  'config',
  'plugins',
  'gcalendar',
  'skills',
  'gcalendar',
  'scripts',
  'gcalendar'
);
const GDRIVE_SCRIPT = path.join(
  WORKSPACE_ROOT,
  '.gemini',
  'config',
  'plugins',
  'gdrive',
  'skills',
  'gdrive',
  'scripts',
  'gdrive'
);

/**
 * Gemini Interactions API & OpenAI-Compatible Function Declarations
 */
const TOOL_DECLARATIONS = [
  {
    type: 'function',
    name: 'get_owner_profile_and_location',
    description:
      'Returns the owner\'s real current location ("where am I"), current status, availability summary, working hours, timezone, and general profile.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    type: 'function',
    name: 'update_owner_location_or_status',
    description:
      'Updates the owner\'s real current location ("where am I"), status, or availability summary.',
    parameters: {
      type: 'object',
      properties: {
        currentLocation: { type: 'string', description: 'New physical location of the owner' },
        currentStatus: { type: 'string', description: 'New activity/status of the owner' },
        availabilitySummary: { type: 'string', description: 'Updated availability note' }
      }
    }
  },
  {
    type: 'function',
    name: 'check_availability_and_free_slots',
    description:
      'Checks the owner\'s real Google Calendar (via gcalendar CLI) and saved schedule to report exact busy blocks and free time windows.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Optional YYYY-MM-DD date to check availability for (defaults to today).'
        }
      }
    }
  },
  {
    type: 'function',
    name: 'list_calendar_events',
    description:
      'Lists the owner\'s real Google Calendar events (via live gcalendar CLI) and saved calendar events.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Optional YYYY-MM-DD date filter.'
        }
      }
    }
  },
  {
    type: 'function',
    name: 'create_calendar_event',
    description:
      'Schedules a real calendar event on Google Calendar (if authenticated) and the owner\'s schedule.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the event or meeting' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (defaults to today)' },
        time: { type: 'string', description: 'Start time in HH:MM 24-hour format (e.g. "15:30")' },
        durationMinutes: { type: 'number', description: 'Duration in minutes (default 30)' },
        location: { type: 'string', description: 'Location or meeting link' }
      },
      required: ['title', 'time']
    }
  },
  {
    type: 'function',
    name: 'inspect_codebase_and_files',
    description:
      'Accesses the owner\'s real codebase and files on disk: lists project files, reads source code files, or searches code across the workspace.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '"list" (list directory files), "read" (read a file), or "search" (grep for text across code files)'
        },
        targetPath: {
          type: 'string',
          description: 'Relative path inside the workspace (e.g. "riz-assistant/src/server.js" or ".")'
        },
        query: {
          type: 'string',
          description: 'Search pattern when action is "search"'
        }
      },
      required: ['action']
    }
  },
  {
    type: 'function',
    name: 'github_and_git_operations',
    description:
      'Executes real Git commands on local repositories (status, log, branches, diff) or queries the live GitHub REST API for the owner\'s repositories, commits, and issues.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: '"git_status", "git_log", "github_repos", "github_user", or "github_search"'
        },
        usernameOrQuery: {
          type: 'string',
          description: 'GitHub username, repo name (owner/repo), or search query'
        }
      },
      required: ['operation']
    }
  },
  {
    type: 'function',
    name: 'list_tasks_and_notes',
    description: 'Retrieves the owner\'s real saved tasks, reminders, and notes.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional search keyword to filter tasks or notes.'
        }
      }
    }
  },
  {
    type: 'function',
    name: 'create_task_or_note',
    description: 'Creates a new personal task/reminder or saves a persistent note.',
    parameters: {
      type: 'object',
      properties: {
        itemType: {
          type: 'string',
          description: 'Either "task" or "note"'
        },
        title: {
          type: 'string',
          description: 'Task description or note title'
        },
        content: {
          type: 'string',
          description: 'Detailed note content or task priority ("high", "medium", "low")'
        }
      },
      required: ['itemType', 'title']
    }
  },
  {
    type: 'function',
    name: 'search_emails',
    description:
      'Searches the owner\'s real Gmail inbox (via Gmail API if token is configured) and real saved/sent emails.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword, sender email, or "unread" to filter emails.'
        }
      }
    }
  },
  {
    type: 'function',
    name: 'send_or_draft_email',
    description: 'Drafts or sends an email and generates a direct mailto / Gmail compose link.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    type: 'function',
    name: 'open_app_or_deeplink',
    description:
      'Launches an installed app or deep-link action (WhatsApp, Gmail, Google Calendar, Google Drive, Spotify, YouTube, Google Maps, GitHub).',
    parameters: {
      type: 'object',
      properties: {
        appName: {
          type: 'string',
          description: 'Name of the application to open'
        },
        actionOrQuery: {
          type: 'string',
          description: 'Optional search query, phone number, or URL target'
        }
      },
      required: ['appName']
    }
  },
  {
    type: 'function',
    name: 'get_connected_accounts_and_system_status',
    description:
      'Returns the real connection status of all user accounts/CLIs (WhatsApp, Google Calendar CLI, GitHub, Gmail, Drive) and live system metrics.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    type: 'function',
    name: 'list_workspace_files',
    description: 'Lists real files and folders in the owner\'s workspace directory.',
    parameters: {
      type: 'object',
      properties: {
        subdir: {
          type: 'string',
          description: 'Optional relative subdirectory inside the workspace'
        }
      }
    }
  }
];

const APP_DEEPLINKS = {
  whatsapp: (q) => (q ? `https://wa.me/?text=${encodeURIComponent(q)}` : 'https://wa.me/'),
  spotify: (q) => (q ? `https://open.spotify.com/search/${encodeURIComponent(q)}` : 'https://open.spotify.com'),
  gmail: (q) => (q ? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}` : 'https://mail.google.com'),
  calendar: () => 'https://calendar.google.com',
  'google calendar': () => 'https://calendar.google.com',
  drive: () => 'https://drive.google.com',
  'google drive': () => 'https://drive.google.com',
  youtube: (q) => (q ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` : 'https://www.youtube.com'),
  maps: (q) => (q ? `https://www.google.com/maps/search/${encodeURIComponent(q)}` : 'https://maps.google.com'),
  'google maps': (q) => (q ? `https://www.google.com/maps/search/${encodeURIComponent(q)}` : 'https://maps.google.com'),
  github: (q) => (q ? `https://github.com/search?q=${encodeURIComponent(q)}` : 'https://github.com')
};

function computeEndTime(startTime, durationMinutes) {
  const [hh, mm] = String(startTime || '12:00').split(':').map((n) => parseInt(n, 10) || 0);
  const totalMins = hh * 60 + mm + (Number(durationMinutes) || 30);
  const endH = Math.floor(totalMins / 60) % 24;
  const endM = totalMins % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

function computeFreeWindows(events) {
  const sorted = [...events].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  const busyBlocks = sorted.map((e) => ({
    title: e.title,
    start: e.time,
    end: e.endTime || computeEndTime(e.time, e.durationMinutes),
    location: e.location || 'Calendar'
  }));

  const freeWindows = [];
  let cursor = '09:00';
  for (const b of busyBlocks) {
    if (b.start > cursor) {
      freeWindows.push(`${cursor} – ${b.start}`);
    }
    if (b.end > cursor) {
      cursor = b.end;
    }
  }
  if (cursor < '22:00') {
    freeWindows.push(`${cursor} – 22:00`);
  }
  return { busyBlocks, freeWindows };
}

/**
 * Queries real Google Calendar events via the official gcalendar CLI if signed in.
 */
function fetchRealGoogleCalendarEvents(dateStr) {
  if (!fs.existsSync(GCALENDAR_SCRIPT)) {
    return { connected: false, events: [], authNote: 'gcalendar CLI script not found' };
  }
  try {
    const cliArgs = ['readonly', 'events', '--max', '25', '--json'];
    if (dateStr) {
      cliArgs.push('--date', dateStr);
    }
    const stdout = execFileSync(GCALENDAR_SCRIPT, cliArgs, {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: '/home/droid',
        ANTIGRAVITY_APP_DATA_DIR: '/home/droid/.gemini/antigravity'
      }
    });
    const parsed = JSON.parse(stdout);
    const items = Array.isArray(parsed) ? parsed : parsed.items || parsed.events || [];
    const seenRecurringTitles = new Set();
    const normalized = [];

    for (const ev of items) {
      const title = ev.summary || ev.title || '(Untitled Event)';
      if (!dateStr && seenRecurringTitles.has(title)) {
        continue;
      }
      seenRecurringTitles.add(title);

      const startRaw = (ev.start && (ev.start.dateTime || ev.start.date)) || ev.startTime || '';
      const endRaw = (ev.end && (ev.end.dateTime || ev.end.date)) || ev.endTime || '';
      const datePart = startRaw ? String(startRaw).slice(0, 10) : dateStr || new Date().toISOString().slice(0, 10);
      const timePart =
        startRaw && String(startRaw).includes('T') ? String(startRaw).slice(11, 16) : 'All Day';
      const endTimePart =
        endRaw && String(endRaw).includes('T')
          ? String(endRaw).slice(11, 16)
          : timePart === 'All Day'
          ? 'All Day'
          : computeEndTime(timePart, 30);

      normalized.push({
        id: ev.id || `gcal-${Math.random().toString(36).slice(2, 7)}`,
        title,
        date: datePart,
        time: timePart,
        endTime: endTimePart,
        durationMinutes: 30,
        location: ev.location || ev.hangoutLink || 'Google Calendar',
        source: 'Google Calendar (yazeedx@gmail.com)'
      });
    }
    return { connected: true, account: 'yazeedx@gmail.com', events: normalized, authNote: null };
  } catch (err) {
    const stderr = String((err && err.stderr) || err.message || '');
    return {
      connected: false,
      events: [],
      authNote: stderr.includes('no credentials found')
        ? 'Google Calendar CLI needs one-time OAuth login (gcalendar auth login).'
        : stderr.trim()
    };
  }
}

async function executeTool(name, args = {}) {
  const state = loadState();
  const dotEnv = loadDotEnvVars();

  switch (name) {
    case 'get_owner_profile_and_location': {
      return {
        status: 'success',
        ownerProfile: state.ownerProfile,
        notes: state.notes
      };
    }

    case 'update_owner_location_or_status': {
      if (args.currentLocation) state.ownerProfile.currentLocation = args.currentLocation;
      if (args.currentStatus) state.ownerProfile.currentStatus = args.currentStatus;
      if (args.availabilitySummary) state.ownerProfile.availabilitySummary = args.availabilitySummary;
      saveState(state);
      return {
        status: 'success',
        message: 'Updated owner location and status.',
        ownerProfile: state.ownerProfile
      };
    }

    case 'check_availability_and_free_slots': {
      const targetDate = (args.date || '').trim() || new Date().toISOString().slice(0, 10);
      const gcal = fetchRealGoogleCalendarEvents(targetDate);
      const localDayEvents = state.calendarEvents.filter((e) => !e.date || e.date === targetDate);
      const combinedEvents = [...gcal.events, ...localDayEvents];
      const { busyBlocks, freeWindows } = computeFreeWindows(combinedEvents);
      return {
        status: 'success',
        date: targetDate,
        googleCalendarLiveConnected: gcal.connected,
        googleCalendarAuthNote: gcal.authNote,
        currentStatus: state.ownerProfile.currentStatus,
        currentLocation: state.ownerProfile.currentLocation,
        workingHours: state.ownerProfile.workingHours,
        availabilitySummary: state.ownerProfile.availabilitySummary,
        busyBlocks,
        freeWindows
      };
    }

    case 'list_calendar_events': {
      const dateFilter = (args.date || '').trim();
      const gcal = fetchRealGoogleCalendarEvents(dateFilter || undefined);
      const localEvents = dateFilter
        ? state.calendarEvents.filter((e) => e.date === dateFilter)
        : state.calendarEvents;
      const allEvents = [...gcal.events, ...localEvents];
      return {
        status: 'success',
        googleCalendarLiveConnected: gcal.connected,
        googleCalendarAuthNote: gcal.authNote,
        count: allEvents.length,
        events: allEvents
      };
    }

    case 'create_calendar_event': {
      const date = args.date || new Date().toISOString().slice(0, 10);
      const time = args.time || '12:00';
      const durationMinutes = Number(args.durationMinutes) || 30;
      const endTime = computeEndTime(time, durationMinutes);
      let gcalCreatedLink = null;

      if (fs.existsSync(GCALENDAR_SCRIPT)) {
        try {
          const startIso = `${date}T${time}:00+03:00`;
          const endIso = `${date}T${endTime}:00+03:00`;
          const out = execFileSync(
            GCALENDAR_SCRIPT,
            ['mutate', 'create', '--summary', args.title || 'Meeting', '--start', startIso, '--end', endIso],
            { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }
          );
          const linkMatch = String(out).match(/https:\/\/\S+/);
          if (linkMatch) gcalCreatedLink = linkMatch[0];
        } catch (_) {}
      }

      const newEvent = {
        id: 'evt-' + Date.now(),
        title: args.title || 'Untitled Event',
        date,
        time,
        endTime,
        durationMinutes,
        location: args.location || 'Google Calendar',
        attendees: [],
        createdBy: gcalCreatedLink ? 'Google Calendar (Live)' : 'Riz Assistant'
      };
      state.calendarEvents.push(newEvent);
      saveState(state);

      const startCompact = date.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
      const gcalUrl =
        gcalCreatedLink ||
        `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(
          newEvent.title
        )}&dates=${startCompact}/${startCompact}&location=${encodeURIComponent(newEvent.location)}`;

      return {
        status: 'success',
        message: `Scheduled "${newEvent.title}" on ${newEvent.date} at ${newEvent.time}.`,
        syncedToLiveGoogleCalendar: Boolean(gcalCreatedLink),
        event: newEvent,
        googleCalendarLink: gcalUrl
      };
    }

    case 'inspect_codebase_and_files': {
      const action = (args.action || 'list').toLowerCase();
      const relTarget = String(args.targetPath || '.').replace(/\.\./g, '');
      const resolvedPath = path.resolve(WORKSPACE_ROOT, relTarget);

      if (action === 'read') {
        if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
          return { status: 'error', message: `File not found or is a directory: ${relTarget}` };
        }
        const content = fs.readFileSync(resolvedPath, 'utf8').slice(0, 8000);
        return {
          status: 'success',
          action: 'read',
          file: relTarget,
          content
        };
      }

      if (action === 'search') {
        const pattern = String(args.query || '').trim();
        if (!pattern) {
          return { status: 'error', message: 'Missing search query' };
        }
        try {
          const out = execFileSync(
            'grep',
            ['-rnI', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=.gemini', pattern, resolvedPath],
            { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }
          );
          const matches = out.split('\n').filter(Boolean).slice(0, 30);
          return {
            status: 'success',
            action: 'search',
            query: pattern,
            matches
          };
        } catch (err) {
          return {
            status: 'success',
            action: 'search',
            query: pattern,
            matches: []
          };
        }
      }

      // Default: list files
      if (!fs.existsSync(resolvedPath)) {
        return { status: 'error', message: `Directory not found: ${relTarget}` };
      }
      const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.gemini'))
        .slice(0, 60)
        .map((d) => ({
          name: d.name,
          type: d.isDirectory() ? 'directory' : 'file'
        }));
      return {
        status: 'success',
        action: 'list',
        directory: resolvedPath,
        entries
      };
    }

    case 'github_and_git_operations': {
      const op = String(args.operation || 'git_status').toLowerCase();
      const ghToken = state.config.githubToken || process.env.GITHUB_TOKEN || dotEnv.GITHUB_TOKEN || '';
      const ghUser =
        args.usernameOrQuery ||
        state.config.githubUsername ||
        process.env.GITHUB_USERNAME ||
        dotEnv.GITHUB_USERNAME ||
        '';

      if (op === 'git_status' || op === 'git_log') {
        const projectDir = path.resolve(__dirname, '..');
        try {
          const cmd = op === 'git_log' ? 'git log -n 10 --oneline' : 'git status -s && git branch -a';
          const out = execSync(cmd, { cwd: projectDir, encoding: 'utf8', timeout: 5000 });
          return {
            status: 'success',
            operation: op,
            workingDirectory: projectDir,
            output: out.trim() || 'Clean working tree'
          };
        } catch (err) {
          return {
            status: 'info',
            operation: op,
            message: err.message
          };
        }
      }

      const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Riz-AI-Assistant'
      };
      if (ghToken) {
        headers.Authorization = `Bearer ${ghToken}`;
      }

      try {
        if (op === 'github_repos') {
          const url = ghToken && !args.usernameOrQuery
            ? 'https://api.github.com/user/repos?sort=updated&per_page=15'
            : ghUser
            ? `https://api.github.com/users/${encodeURIComponent(ghUser)}/repos?sort=updated&per_page=15`
            : null;

          if (!url) {
            return {
              status: 'needs_input',
              message: 'No GitHub username or GITHUB_TOKEN configured yet. Provide a GitHub username or set GITHUB_TOKEN.'
            };
          }
          const res = await fetch(url, { headers });
          const data = await res.json();
          if (!res.ok) {
            return { status: 'error', httpStatus: res.status, error: data };
          }
          const repos = (Array.isArray(data) ? data : []).map((r) => ({
            name: r.full_name,
            private: r.private,
            description: r.description,
            language: r.language,
            updatedAt: r.updated_at,
            url: r.html_url
          }));
          return { status: 'success', count: repos.length, repositories: repos };
        }

        if (op === 'github_user') {
          const url = ghToken && !args.usernameOrQuery
            ? 'https://api.github.com/user'
            : ghUser
            ? `https://api.github.com/users/${encodeURIComponent(ghUser)}`
            : null;
          if (!url) {
            return {
              status: 'needs_input',
              message: 'Specify a GitHub username or configure GITHUB_TOKEN.'
            };
          }
          const res = await fetch(url, { headers });
          const data = await res.json();
          return { status: res.ok ? 'success' : 'error', profile: data };
        }

        if (op === 'github_search') {
          const q = args.usernameOrQuery || 'riz';
          const res = await fetch(
            `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=10`,
            { headers }
          );
          const data = await res.json();
          const items = (data.items || []).map((r) => ({
            name: r.full_name,
            description: r.description,
            stars: r.stargazers_count,
            url: r.html_url
          }));
          return { status: 'success', query: q, results: items };
        }
      } catch (err) {
        return { status: 'error', message: err.message };
      }

      return { status: 'error', message: `Unsupported GitHub operation: ${op}` };
    }

    case 'list_tasks_and_notes': {
      const q = (args.query || '').toLowerCase().trim();
      const tasks = q
        ? state.tasks.filter((t) => t.title.toLowerCase().includes(q))
        : state.tasks;
      const notes = q
        ? state.notes.filter(
            (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
          )
        : state.notes;
      return {
        status: 'success',
        tasks,
        notes
      };
    }

    case 'create_task_or_note': {
      const type = (args.itemType || 'task').toLowerCase();
      if (type === 'note') {
        const newNote = {
          id: 'note-' + Date.now(),
          title: args.title,
          content: args.content || '',
          updatedAt: new Date().toISOString()
        };
        state.notes.unshift(newNote);
        saveState(state);
        return {
          status: 'success',
          message: `Saved note "${newNote.title}".`,
          note: newNote
        };
      } else {
        const newTask = {
          id: 'tsk-' + Date.now(),
          title: args.title,
          priority: ['high', 'medium', 'low'].includes((args.content || '').toLowerCase())
            ? args.content.toLowerCase()
            : 'medium',
          completed: false,
          createdAt: new Date().toISOString()
        };
        state.tasks.unshift(newTask);
        saveState(state);
        return {
          status: 'success',
          message: `Created task "${newTask.title}".`,
          task: newTask
        };
      }
    }

    case 'search_emails': {
      const q = (args.query || '').toLowerCase().trim();
      const gmailToken = process.env.GMAIL_ACCESS_TOKEN || dotEnv.GMAIL_ACCESS_TOKEN || '';

      if (gmailToken) {
        try {
          const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10${
            q ? `&q=${encodeURIComponent(q)}` : ''
          }`;
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${gmailToken}` }
          });
          if (res.ok) {
            const listData = await res.json();
            return {
              status: 'success',
              source: 'Live Gmail API',
              messages: listData.messages || []
            };
          }
        } catch (_) {}
      }

      let emails = state.emails;
      if (q === 'unread') {
        emails = emails.filter((e) => e.unread);
      } else if (q) {
        emails = emails.filter(
          (e) =>
            e.from.toLowerCase().includes(q) ||
            e.subject.toLowerCase().includes(q) ||
            e.snippet.toLowerCase().includes(q)
        );
      }
      return {
        status: 'success',
        gmailApiConfigured: Boolean(gmailToken),
        count: emails.length,
        emails,
        note:
          emails.length === 0 && !gmailToken
            ? 'No emails stored locally and GMAIL_ACCESS_TOKEN is not yet configured.'
            : undefined
      };
    }

    case 'send_or_draft_email': {
      const newEmail = {
        id: 'eml-' + Date.now(),
        from: 'me@gmail.com',
        to: args.to,
        subject: args.subject,
        snippet: args.body,
        unread: false,
        timestamp: new Date().toISOString()
      };
      state.emails.unshift(newEmail);
      saveState(state);
      const mailtoUrl = `mailto:${encodeURIComponent(args.to)}?subject=${encodeURIComponent(
        args.subject
      )}&body=${encodeURIComponent(args.body)}`;
      return {
        status: 'success',
        message: `Prepared email to ${args.to} with subject "${args.subject}".`,
        email: newEmail,
        mailtoLink: mailtoUrl
      };
    }

    case 'open_app_or_deeplink': {
      const key = (args.appName || '').toLowerCase().trim();
      const builder = APP_DEEPLINKS[key];
      const launchUrl = builder
        ? builder(args.actionOrQuery)
        : `https://www.google.com/search?q=${encodeURIComponent(args.appName + ' ' + (args.actionOrQuery || ''))}`;
      return {
        status: 'success',
        appName: args.appName,
        actionOrQuery: args.actionOrQuery || null,
        launchUrl,
        message: `Ready to open ${args.appName}.`
      };
    }

    case 'get_connected_accounts_and_system_status': {
      const gcal = fetchRealGoogleCalendarEvents();
      return {
        status: 'success',
        accounts: state.accounts,
        googleCalendarCliAuthenticated: gcal.connected,
        geminiApiKeyConfigured: Boolean(state.config.geminiApiKey),
        githubTokenConfigured: Boolean(state.config.githubToken),
        systemHealth: {
          platform: os.platform(),
          arch: os.arch(),
          hostname: os.hostname(),
          uptimeMinutes: Math.round(os.uptime() / 60),
          freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
          totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024)
        }
      };
    }

    case 'list_workspace_files': {
      const targetDir = args.subdir
        ? path.resolve(WORKSPACE_ROOT, args.subdir.replace(/\.\./g, ''))
        : WORKSPACE_ROOT;
      try {
        const entries = fs.readdirSync(targetDir, { withFileTypes: true });
        return {
          status: 'success',
          directory: targetDir,
          files: entries
            .filter((e) => !e.name.startsWith('.'))
            .slice(0, 50)
            .map((e) => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file'
            }))
        };
      } catch (err) {
        return {
          status: 'error',
          message: `Could not list directory: ${err.message}`
        };
      }
    }

    default:
      return {
        status: 'error',
        message: `Unknown tool: ${name}`
      };
  }
}

module.exports = {
  TOOL_DECLARATIONS,
  executeTool
};
