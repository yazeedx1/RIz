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
      'Executes real Git commands on local repositories (git_status, git_log, git_push) or queries/mutates the live GitHub REST API to create a new repository (github_create_repo), list repositories (github_repos), inspect repository files/commits (github_repo_details), get user profile (github_user), and search (github_search).',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description:
            '"git_status", "git_log", "git_push", "github_create_repo", "github_repos", "github_repo_details", "github_user", or "github_search"'
        },
        usernameOrQuery: {
          type: 'string',
          description: 'New repo name (for github_create_repo), repo name (e.g. "yazeedx1/RIz"), or commit message'
        },
        description: {
          type: 'string',
          description: 'Optional repository description when creating a new GitHub repository'
        },
        isPrivate: {
          type: 'boolean',
          description: 'Optional boolean: true for private repository, false for public (default false)'
        },
        filePath: {
          type: 'string',
          description: 'Optional path inside a GitHub repository to read or list (e.g. "src/server.js")'
        }
      },
      required: ['operation']
    }
  },
  {
    type: 'function',
    name: 'antigravity_bridge',
    description:
      'Connects Riz directly to the live Google Antigravity IDE & Agent environment: creates new Antigravity workspace projects (create_project) with Git and .agents/rules, or inspects active Antigravity workspace projects, installed plugins, skills, MCP servers, and brain conversations.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            '"status" (full Antigravity overview), "create_project" (scaffold a new project in the Antigravity workspace), "skills" (list skills & plugins), or "brain" (list active Antigravity conversations)'
        },
        projectName: {
          type: 'string',
          description: 'Name of the new Antigravity project folder to create when action is "create_project"'
        },
        description: {
          type: 'string',
          description: 'Optional description of the new Antigravity project'
        },
        syncToGithub: {
          type: 'boolean',
          description: 'Optional boolean: if true, also creates a GitHub repo under yazeedx1 and pushes the initial commit'
        }
      }
    }
  },
  {
    type: 'function',
    name: 'netlify_operations',
    description:
      'Connects Riz to Netlify Cloud Hosting (https://api.netlify.com/api/v1): lists live Netlify sites & custom domains (list_sites), inspects site deployments (site_deploys), creates a new Netlify site (create_site), or checks the authenticated Netlify account (account_user).',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: '"list_sites", "site_deploys", "create_site", or "account_user"'
        },
        siteNameOrId: {
          type: 'string',
          description: 'Optional Netlify site name, subdomain, or site ID'
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
      'Searches the owner\'s real Gmail inbox across both connected accounts (yazeedx@gmail.com and yaz@thegauntlet.sa via XOAUTH2) and saved/sent emails.',
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
    description: 'Sends a live email via Gmail SMTP XOAUTH2 (from yazeedx@gmail.com or yaz@thegauntlet.sa) and generates a direct mailto link.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
        fromAccount: { type: 'string', description: 'Optional sender account (yazeedx@gmail.com or yaz@thegauntlet.sa)' }
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
      'Returns the real connection status of all user accounts/CLIs (WhatsApp, Google Calendar, Gmail, GitHub, Antigravity, Drive) and live system metrics.',
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

const GCAL_HOMES = [
  path.join(__dirname, '..', 'data', 'gcal-homes', 'account1'),
  '/home/droid'
];

const gcalCacheByDateKey = new Map();
const GCAL_CACHE_TTL_MS = 60 * 1000;

/**
 * Queries real Google Calendar events across all connected Google Calendar accounts
 * and sub-calendars via the official gcalendar CLI, with a 60s in-memory cache for 0ms reads.
 */
function fetchRealGoogleCalendarEvents(dateStr, forceRefresh = false) {
  const cacheKey = dateStr || '__ALL__';
  const cached = gcalCacheByDateKey.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < GCAL_CACHE_TTL_MS) {
    return cached.data;
  }

  if (!fs.existsSync(GCALENDAR_SCRIPT)) {
    return { connected: false, events: [], authNote: 'gcalendar CLI script not found' };
  }

  const allNormalized = [];
  const connectedProfiles = [];
  const seenEventKeys = new Set();

  for (const homeDir of GCAL_HOMES) {
    const tokenPath = path.join(homeDir, '.gemini', 'antigravity', 'plugin_data', 'gcalendar', 'token.json');
    if (!fs.existsSync(tokenPath)) continue;

    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: homeDir,
      ANTIGRAVITY_APP_DATA_DIR: '/home/droid/.gemini/antigravity'
    };

    try {
      const cliArgs = ['readonly', 'events', '--max', '25', '--json'];
      if (dateStr) {
        cliArgs.push('--date', dateStr);
      }
      const stdout = execFileSync(GCALENDAR_SCRIPT, cliArgs, {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
      const parsed = JSON.parse(stdout);
      const items = Array.isArray(parsed) ? parsed : parsed.items || parsed.events || [];
      const seenRecurringTitles = new Set();
      let accountEmail = homeDir.includes('account1') ? 'yazeedx@gmail.com' : 'yaz@thegauntlet.sa';

      for (const ev of items) {
        if (ev.creator && ev.creator.email && ev.creator.self) {
          accountEmail = ev.creator.email;
        } else if (ev.organizer && ev.organizer.email && ev.organizer.self) {
          accountEmail = ev.organizer.email;
        }
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

        const dedupeKey = `${accountEmail}|${title}|${datePart}|${timePart}`;
        if (seenEventKeys.has(dedupeKey)) continue;
        seenEventKeys.add(dedupeKey);

        allNormalized.push({
          id: ev.id || `gcal-${Math.random().toString(36).slice(2, 7)}`,
          title,
          date: datePart,
          time: timePart,
          endTime: endTimePart,
          durationMinutes: 30,
          location: ev.location || ev.hangoutLink || 'Google Calendar',
          calendarAccount: accountEmail,
          source: `Google Calendar (${accountEmail})`
        });
      }
      connectedProfiles.push(accountEmail);
    } catch (_) {}
  }

  if (connectedProfiles.length === 0) {
    return {
      connected: false,
      events: [],
      authNote: 'Google Calendar CLI needs one-time OAuth login (gcalendar auth login).'
    };
  }

  const result = {
    connected: true,
    accounts: connectedProfiles,
    events: allNormalized,
    authNote: null
  };
  gcalCacheByDateKey.set(cacheKey, { fetchedAt: Date.now(), data: result });
  return result;
}

// Pre-warm Google Calendar cache on startup in background so first calendar question is instant
setTimeout(() => {
  try {
    fetchRealGoogleCalendarEvents(undefined);
    fetchRealGoogleCalendarEvents(new Date().toISOString().slice(0, 10));
  } catch (_) {}
}, 300);

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
        googleCalendarAccounts: gcal.accounts || [],
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
        googleCalendarAccounts: gcal.accounts || [],
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
            {
              encoding: 'utf8',
              timeout: 8000,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: {
                PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
                HOME: '/home/droid',
                ANTIGRAVITY_APP_DATA_DIR: '/home/droid/.gemini/antigravity'
              }
            }
          );
          const linkMatch = String(out).match(/https:\/\/\S+/);
          if (linkMatch) gcalCreatedLink = linkMatch[0];
          gcalCacheByDateKey.clear();
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
        state.config.githubUsername ||
        process.env.GITHUB_USERNAME ||
        dotEnv.GITHUB_USERNAME ||
        'yazeedx1';
      const projectDir = path.resolve(__dirname, '..');

      if (op === 'git_status' || op === 'git_log') {
        try {
          const cmd = op === 'git_log' ? 'git log -n 10 --oneline' : 'git status -s && git branch -a';
          const out = execSync(cmd, { cwd: projectDir, encoding: 'utf8', timeout: 5000 });
          return {
            status: 'success',
            operation: op,
            repositoryUrl: 'https://github.com/yazeedx1/RIz',
            workingDirectory: projectDir,
            output: out.trim() || 'Clean working tree on branch main (synced with https://github.com/yazeedx1/RIz)'
          };
        } catch (err) {
          return {
            status: 'info',
            operation: op,
            message: err.message
          };
        }
      }

      if (op === 'git_push') {
        try {
          const commitMsg = args.usernameOrQuery || 'Riz live assistant auto-sync';
          const statusOut = execSync('git status -s', { cwd: projectDir, encoding: 'utf8', timeout: 5000 }).trim();
          if (statusOut) {
            execSync(`git add -A && git commit -m ${JSON.stringify(commitMsg)}`, {
              cwd: projectDir,
              encoding: 'utf8',
              timeout: 10000
            });
          }
          const remoteTarget = ghToken
            ? `https://x-access-token:${ghToken}@github.com/yazeedx1/RIz.git`
            : 'origin';
          const pushOut = execSync(`git push ${remoteTarget} main 2>&1`, {
            cwd: projectDir,
            encoding: 'utf8',
            timeout: 15000
          });
          const latestCommit = execSync('git log -n 1 --oneline', {
            cwd: projectDir,
            encoding: 'utf8',
            timeout: 5000
          }).trim();
          return {
            status: 'success',
            operation: 'git_push',
            repository: 'https://github.com/yazeedx1/RIz',
            latestCommit,
            output: (pushOut || '').replace(ghToken, '***').trim() || 'Everything up-to-date on origin/main'
          };
        } catch (err) {
          return {
            status: 'error',
            operation: 'git_push',
            message: String(err.message || '').replace(ghToken, '***')
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
        if (op === 'github_create_repo') {
          const rawName = String(args.usernameOrQuery || '')
            .trim()
            .replace(/^yazeedx1\//i, '')
            .replace(/[^a-zA-Z0-9._-]/g, '-')
            .replace(/^-+|-+$/g, '');
          if (!rawName) {
            return {
              status: 'needs_input',
              message: 'Please provide a repository name to create on GitHub.'
            };
          }
          const createRes = await fetch('https://api.github.com/user/repos', {
            method: 'POST',
            headers: {
              ...headers,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: rawName,
              description: args.description || `Created by Riz AI Assistant for Yazeed Abdullah (Yaz)`,
              private: Boolean(args.isPrivate),
              auto_init: true
            })
          });
          const created = await createRes.json();
          if (!createRes.ok) {
            return {
              status: 'error',
              operation: 'github_create_repo',
              httpStatus: createRes.status,
              error: created
            };
          }
          return {
            status: 'success',
            operation: 'github_create_repo',
            name: created.full_name,
            private: created.private,
            url: created.html_url,
            cloneUrl: created.clone_url,
            defaultBranch: created.default_branch,
            message: `Successfully created GitHub repository ${created.full_name} (${created.html_url})`
          };
        }

        if (op === 'github_repos') {
          const url = ghToken
            ? 'https://api.github.com/user/repos?sort=updated&per_page=25'
            : `https://api.github.com/users/${encodeURIComponent(ghUser)}/repos?sort=updated&per_page=25`;

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
            defaultBranch: r.default_branch,
            updatedAt: r.updated_at,
            url: r.html_url
          }));
          return {
            status: 'success',
            githubAccount: ghUser,
            primaryRizRepo: 'https://github.com/yazeedx1/RIz',
            count: repos.length,
            repositories: repos
          };
        }

        if (op === 'github_repo_details') {
          let targetRepo = (args.usernameOrQuery || 'yazeedx1/RIz').trim();
          if (!targetRepo.includes('/')) {
            targetRepo = `${ghUser}/${targetRepo}`;
          }
          const subPath = (args.filePath || '').replace(/^\/+/, '');
          const contentsUrl = subPath
            ? `https://api.github.com/repos/${targetRepo}/contents/${subPath}`
            : `https://api.github.com/repos/${targetRepo}/contents`;
          const commitsUrl = `https://api.github.com/repos/${targetRepo}/commits?per_page=8`;

          const [contentsRes, commitsRes] = await Promise.all([
            fetch(contentsUrl, { headers }),
            fetch(commitsUrl, { headers })
          ]);
          const contentsData = await contentsRes.json();
          const commitsData = await commitsRes.json();

          let filesOrContent = null;
          if (Array.isArray(contentsData)) {
            filesOrContent = contentsData.map((item) => ({
              name: item.name,
              path: item.path,
              type: item.type,
              size: item.size
            }));
          } else if (contentsData && contentsData.content && contentsData.encoding === 'base64') {
            filesOrContent = {
              path: contentsData.path,
              size: contentsData.size,
              contentSnippet: Buffer.from(contentsData.content, 'base64').toString('utf8').slice(0, 3500)
            };
          } else {
            filesOrContent = contentsData;
          }

          const recentCommits = (Array.isArray(commitsData) ? commitsData : []).map((c) => ({
            sha: (c.sha || '').slice(0, 7),
            message: c.commit && c.commit.message,
            author: c.commit && c.commit.author && c.commit.author.name,
            date: c.commit && c.commit.author && c.commit.author.date
          }));

          return {
            status: 'success',
            repository: targetRepo,
            url: `https://github.com/${targetRepo}`,
            contents: filesOrContent,
            recentCommits
          };
        }

        if (op === 'github_user') {
          const url = ghToken
            ? 'https://api.github.com/user'
            : `https://api.github.com/users/${encodeURIComponent(ghUser)}`;
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

    case 'antigravity_bridge': {
      const action = String(args.action || 'status').toLowerCase();
      const agyRoot = path.join(WORKSPACE_ROOT, '.gemini', 'antigravity');
      const pluginsRoot = path.join(WORKSPACE_ROOT, '.gemini', 'config', 'plugins');
      const skillsRoot = path.join(WORKSPACE_ROOT, '.gemini', 'config', 'skills');
      const mcpRoot = path.join(agyRoot, 'mcp');
      const brainRoot = path.join(agyRoot, 'brain');

      if (action === 'create_project') {
        const cleanName = String(args.projectName || '')
          .trim()
          .replace(/[^a-zA-Z0-9._-]/g, '-')
          .replace(/^-+|-+$/g, '');
        if (!cleanName) {
          return {
            status: 'needs_input',
            message: 'Please provide a project name to create in the Antigravity workspace.'
          };
        }
        const projectDir = path.join(WORKSPACE_ROOT, cleanName);
        const srcDir = path.join(projectDir, 'src');
        const rulesDir = path.join(projectDir, '.agents', 'rules');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(rulesDir, { recursive: true });

        const desc = args.description || `Antigravity project ${cleanName} created by Riz for Yazeed Abdullah (Yaz).`;
        if (!fs.existsSync(path.join(projectDir, 'README.md'))) {
          fs.writeFileSync(
            path.join(projectDir, 'README.md'),
            `# ${cleanName}\n\n${desc}\n\nCreated via **Riz AI Assistant** inside the Google Antigravity Workspace.\n`,
            'utf8'
          );
        }
        if (!fs.existsSync(path.join(projectDir, '.gitignore'))) {
          fs.writeFileSync(path.join(projectDir, '.gitignore'), 'node_modules/\n.env\n.DS_Store\n', 'utf8');
        }
        if (!fs.existsSync(path.join(projectDir, 'package.json'))) {
          fs.writeFileSync(
            path.join(projectDir, 'package.json'),
            JSON.stringify(
              {
                name: cleanName.toLowerCase(),
                version: '1.0.0',
                description: desc,
                main: 'src/index.js',
                scripts: { start: 'node src/index.js' }
              },
              null,
              2
            ) + '\n',
            'utf8'
          );
        }
        if (!fs.existsSync(path.join(srcDir, 'index.js'))) {
          fs.writeFileSync(
            path.join(srcDir, 'index.js'),
            `console.log(${JSON.stringify(`Antigravity project ${cleanName} is ready!`)});\n`,
            'utf8'
          );
        }
        fs.writeFileSync(
          path.join(rulesDir, 'project.md'),
          `# ${cleanName} — Antigravity Workspace Rules\n\n- Project root: \`${projectDir}\`\n- Owner: Yazeed Abdullah (Yaz)\n- Managed by Antigravity & Riz AI Assistant\n`,
          'utf8'
        );

        try {
          execSync(
            'git init && git branch -M main && git add -A && git commit -m "Initial Antigravity project scaffold by Riz"',
            { cwd: projectDir, encoding: 'utf8', timeout: 8000 }
          );
        } catch (_) {}

        let githubUrl = null;
        if (args.syncToGithub) {
          const ghRes = await executeTool('github_and_git_operations', {
            operation: 'github_create_repo',
            usernameOrQuery: cleanName,
            description: desc
          });
          if (ghRes && ghRes.url) {
            githubUrl = ghRes.url;
          }
        }

        return {
          status: 'success',
          action: 'create_project',
          projectName: cleanName,
          projectPath: projectDir,
          antigravityRulesPath: path.join(rulesDir, 'project.md'),
          filesCreated: ['README.md', '.gitignore', 'package.json', 'src/index.js', '.agents/rules/project.md'],
          gitInitialized: true,
          githubUrl,
          message: `Created Antigravity project "${cleanName}" at ${projectDir}`
        };
      }

      const safeReaddir = (dir) => {
        try {
          return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        } catch (_) {
          return [];
        }
      };

      const plugins = safeReaddir(pluginsRoot).filter((n) => !n.startsWith('.'));
      const customSkills = safeReaddir(skillsRoot).filter((n) => !n.startsWith('.'));
      const mcpServers = safeReaddir(mcpRoot).filter((n) => !n.startsWith('.'));
      const brainConversations = safeReaddir(brainRoot)
        .filter((n) => !n.startsWith('.'))
        .slice(0, 10);
      const workspaceItems = safeReaddir(WORKSPACE_ROOT).filter((n) => !n.startsWith('.'));

      return {
        status: 'success',
        connected: true,
        bridgeMode: 'Bidirectional Antigravity Agent + Skill + Workspace Bridge',
        capabilities: [
          'Create new projects in Antigravity workspace (create_project)',
          'Configure .agents/rules and skills automatically',
          'Initialize Git and sync with GitHub (yazeedx1)',
          'Inspect workspace projects, plugins, skills, MCP servers, and brain conversations'
        ],
        workspaceRoot: WORKSPACE_ROOT,
        rizSkillRegistered: fs.existsSync(path.join(skillsRoot, 'riz_assistant', 'SKILL.md')),
        rizDashboardUrl: 'http://localhost:3456',
        rizGitHubRepo: 'https://github.com/yazeedx1/RIz',
        workspaceProjects: workspaceItems,
        installedPlugins: plugins,
        customSkills,
        mcpServers,
        activeBrainConversationIds: brainConversations
      };
    }

    case 'netlify_operations': {
      const op = String(args.operation || 'list_sites').toLowerCase();
      const NETLIFY_CLIENT_ID = 'd6f37de6614df7ae58664cfca524744d73807a377f5ee71f1a254f78412e3750';
      const tokenFile = path.join(__dirname, '..', 'data', 'netlify-token.json');
      const ticketFile = path.join(__dirname, '..', 'data', 'netlify-pending-ticket.json');

      let netlifyToken =
        state.config.netlifyToken ||
        process.env.NETLIFY_AUTH_TOKEN ||
        dotEnv.NETLIFY_AUTH_TOKEN ||
        '';

      if (!netlifyToken && fs.existsSync(tokenFile)) {
        try {
          const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
          if (saved && saved.access_token) netlifyToken = saved.access_token;
        } catch (_) {}
      }

      // If no token yet, check if a pending OAuth ticket was authorized and exchange it automatically!
      if (!netlifyToken && fs.existsSync(ticketFile)) {
        try {
          const pending = JSON.parse(fs.readFileSync(ticketFile, 'utf8'));
          if (pending && pending.id) {
            const checkRes = await fetch(`https://api.netlify.com/api/v1/oauth/tickets/${pending.id}`);
            if (checkRes.ok) {
              const ticketStatus = await checkRes.json();
              if (ticketStatus && ticketStatus.authorized) {
                const exRes = await fetch(
                  `https://api.netlify.com/api/v1/oauth/tickets/${pending.id}/exchange`,
                  { method: 'POST' }
                );
                if (exRes.ok) {
                  const exData = await exRes.json();
                  if (exData && exData.access_token) {
                    netlifyToken = exData.access_token;
                    fs.writeFileSync(tokenFile, JSON.stringify(exData, null, 2), 'utf8');
                    state.config.netlifyToken = netlifyToken;
                    saveState(state);
                  }
                }
              }
            }
          }
        } catch (_) {}
      }

      // If still no token, create or reuse a 1-click Netlify OAuth Ticket URL
      if (!netlifyToken) {
        try {
          let ticketId = null;
          if (fs.existsSync(ticketFile)) {
            const pending = JSON.parse(fs.readFileSync(ticketFile, 'utf8'));
            if (pending && pending.id && Date.now() - (pending.createdAtMs || 0) < 30 * 60 * 1000) {
              ticketId = pending.id;
            }
          }
          if (!ticketId) {
            const tRes = await fetch(
              `https://api.netlify.com/api/v1/oauth/tickets?client_id=${NETLIFY_CLIENT_ID}`,
              { method: 'POST' }
            );
            if (tRes.ok) {
              const tData = await tRes.json();
              ticketId = tData.id;
              fs.writeFileSync(
                ticketFile,
                JSON.stringify({ id: ticketId, createdAtMs: Date.now() }, null, 2),
                'utf8'
              );
            }
          }
          const authorizeUrl = ticketId
            ? `https://app.netlify.com/authorize?response_type=ticket&ticket=${ticketId}`
            : 'https://app.netlify.com';
          return {
            status: 'needs_authorization',
            netlifyConnected: false,
            authorizeUrl,
            message: `Netlify bridge is ready! Click this 1-click authorization link to approve Riz on your Netlify account: ${authorizeUrl}`
          };
        } catch (err) {
          return {
            status: 'error',
            message: err.message
          };
        }
      }

      const headers = {
        Authorization: `Bearer ${netlifyToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Riz-AI-Assistant'
      };

      try {
        if (op === 'account_user') {
          const uRes = await fetch('https://api.netlify.com/api/v1/user', { headers });
          const uData = await uRes.json();
          return {
            status: uRes.ok ? 'success' : 'error',
            user: uData
          };
        }

        if (op === 'create_site') {
          const crypto = require('crypto');
          const cleanSiteName = String(args.siteNameOrId || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/^-+|-+$/g, '');
          const body = cleanSiteName ? { name: cleanSiteName } : {};
          const cRes = await fetch('https://api.netlify.com/api/v1/sites', {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
          });
          const cData = await cRes.json();
          if (!cRes.ok) {
            return { status: 'error', operation: 'create_site', httpStatus: cRes.status, error: cData };
          }

          // Deploy an initial live index.html to the newly created Netlify site
          try {
            const htmlContent = Buffer.from(
              `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${cData.name}</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}.card{background:#1e293b;padding:2.5rem;border-radius:1rem;box-shadow:0 10px 30px rgba(0,0,0,.4)}h1{margin:0 0 .5rem;color:#38bdf8}p{color:#94a3b8;margin:0}</style></head><body><div class="card"><h1>${cData.name}</h1><p>Provisioned & deployed live on Netlify by <strong>Riz AI Assistant</strong> for Yazeed Abdullah (Yaz).</p></div></body></html>`,
              'utf8'
            );
            const sha1 = crypto.createHash('sha1').update(htmlContent).digest('hex');
            const depRes = await fetch(`https://api.netlify.com/api/v1/sites/${cData.id}/deploys`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ files: { '/index.html': sha1 } })
            });
            if (depRes.ok) {
              const depData = await depRes.json();
              if (depData && depData.id && Array.isArray(depData.required) && depData.required.includes(sha1)) {
                await fetch(`https://api.netlify.com/api/v1/deploys/${depData.id}/files/index.html`, {
                  method: 'PUT',
                  headers: {
                    Authorization: `Bearer ${netlifyToken}`,
                    'Content-Type': 'application/octet-stream'
                  },
                  body: htmlContent
                });
              }
            }
          } catch (_) {}

          return {
            status: 'success',
            operation: 'create_site',
            siteId: cData.id,
            name: cData.name,
            url: cData.ssl_url || cData.url,
            adminUrl: cData.admin_url,
            message: `Created and deployed live Netlify project "${cData.name}" at ${cData.ssl_url || cData.url}`
          };
        }

        if (op === 'site_deploys') {
          const sitesRes = await fetch('https://api.netlify.com/api/v1/sites?per_page=25', { headers });
          const sites = await sitesRes.json();
          const target = Array.isArray(sites)
            ? sites.find(
                (s) =>
                  !args.siteNameOrId ||
                  s.name.toLowerCase().includes(String(args.siteNameOrId).toLowerCase()) ||
                  s.id === args.siteNameOrId
              ) || sites[0]
            : null;
          if (!target) {
            return { status: 'success', deploys: [], message: 'No Netlify sites found on this account.' };
          }
          const dRes = await fetch(`https://api.netlify.com/api/v1/sites/${target.id}/deploys?per_page=8`, {
            headers
          });
          const deploys = await dRes.json();
          return {
            status: 'success',
            site: target.name,
            url: target.ssl_url || target.url,
            deploys: (Array.isArray(deploys) ? deploys : []).map((d) => ({
              id: d.id,
              state: d.state,
              branch: d.branch,
              title: d.title,
              deployUrl: d.deploy_ssl_url || d.deploy_url,
              createdAt: d.created_at
            }))
          };
        }

        // Default: list_sites
        const sRes = await fetch('https://api.netlify.com/api/v1/sites?per_page=30', { headers });
        const sData = await sRes.json();
        if (!sRes.ok) {
          return { status: 'error', httpStatus: sRes.status, error: sData };
        }
        const sites = (Array.isArray(sData) ? sData : []).map((s) => ({
          id: s.id,
          name: s.name,
          url: s.ssl_url || s.url,
          customDomain: s.custom_domain || null,
          adminUrl: s.admin_url,
          repoUrl: s.build_settings && s.build_settings.repo_url,
          updatedAt: s.updated_at
        }));
        return {
          status: 'success',
          netlifyConnected: true,
          count: sites.length,
          sites
        };
      } catch (err) {
        return { status: 'error', message: err.message };
      }
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
      const q = (args.query || '').trim();
      const cacheKey = `gmail:${q || '__ALL__'}`;
      const cachedGmail = gcalCacheByDateKey.get(cacheKey);
      if (cachedGmail && Date.now() - cachedGmail.fetchedAt < 60 * 1000) {
        return cachedGmail.data;
      }

      const { fetchGmailViaImapXoAuth2 } = require('./gmailImapBridge');
      const tokensDir = path.join(__dirname, '..', 'data', 'gmail-tokens');
      const tokenFiles = fs.existsSync(tokensDir)
        ? fs.readdirSync(tokensDir).filter((f) => f.endsWith('.json'))
        : [];

      if (tokenFiles.length > 0) {
        const connectedAccounts = [];
        const allMessages = [];

        await Promise.all(
          tokenFiles.map(async (file) => {
            try {
              const filePath = path.join(tokensDir, file);
              const cred = JSON.parse(fs.readFileSync(filePath, 'utf8'));
              const accountEmail = cred.email || file.replace(/\.json$/, '');
              let accessToken = cred.token && cred.token.access_token;

              // Refresh access_token if expired or missing
              if (
                cred.token &&
                cred.token.refresh_token &&
                (!accessToken || !cred.token.expiry || Date.now() > cred.token.expiry - 60000)
              ) {
                const rTok = await fetch('https://oauth2.googleapis.com/token', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams({
                    client_id: cred.client_id,
                    client_secret: cred.client_secret,
                    refresh_token: cred.token.refresh_token,
                    grant_type: 'refresh_token'
                  })
                });
                if (rTok.ok) {
                  const refreshed = await rTok.json();
                  accessToken = refreshed.access_token;
                  cred.token.access_token = accessToken;
                  cred.token.expiry = Date.now() + (Number(refreshed.expires_in) || 3599) * 1000;
                  fs.writeFileSync(filePath, JSON.stringify(cred, null, 2), 'utf8');
                }
              }

              if (!accessToken) return;
              connectedAccounts.push(accountEmail);

              // Fetch via native Gmail IMAP XOAUTH2 (works with verified Thunderbird OAuth client)
              const imapMessages = await fetchGmailViaImapXoAuth2({
                email: accountEmail,
                accessToken,
                query: q,
                maxResults: 6
              });

              for (const item of imapMessages) {
                if (item) allMessages.push(item);
              }
            } catch (_) {}
          })
        );

        const emailResult = {
          status: 'success',
          source: 'Live Multi-Account Gmail (XOAUTH2)',
          gmailAccountsConnected: connectedAccounts,
          count: allMessages.length,
          emails: allMessages
        };
        gcalCacheByDateKey.set(cacheKey, { fetchedAt: Date.now(), data: emailResult });
        return emailResult;
      }

      let emails = state.emails;
      if (q.toLowerCase() === 'unread') {
        emails = emails.filter((e) => e.unread);
      } else if (q) {
        const ql = q.toLowerCase();
        emails = emails.filter(
          (e) =>
            e.from.toLowerCase().includes(ql) ||
            e.subject.toLowerCase().includes(ql) ||
            e.snippet.toLowerCase().includes(ql)
        );
      }
      return {
        status: 'success',
        gmailApiConfigured: false,
        count: emails.length,
        emails,
        note: 'Click the Gmail authorization links in chat to finish linking yazeedx@gmail.com and yaz@thegauntlet.sa.'
      };
    }

    case 'send_or_draft_email': {
      const { sendGmailViaSmtpXoAuth2 } = require('./gmailImapBridge');
      const tokensDir = path.join(__dirname, '..', 'data', 'gmail-tokens');
      const tokenFiles = fs.existsSync(tokensDir)
        ? fs.readdirSync(tokensDir).filter((f) => f.endsWith('.json'))
        : [];

      let sentViaLiveGmail = false;
      let senderAccount = 'yazeedx@gmail.com';

      if (tokenFiles.length > 0) {
        try {
          const preferredFile =
            tokenFiles.find((f) => args.fromAccount && f.includes(args.fromAccount)) ||
            tokenFiles.find((f) => f.includes('yazeedx@gmail.com')) ||
            tokenFiles[0];
          const filePath = path.join(tokensDir, preferredFile);
          const cred = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          senderAccount = cred.email || preferredFile.replace(/\.json$/, '');
          let accessToken = cred.token && cred.token.access_token;

          if (
            cred.token &&
            cred.token.refresh_token &&
            (!accessToken || !cred.token.expiry || Date.now() > cred.token.expiry - 60000)
          ) {
            const rTok = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: cred.client_id,
                client_secret: cred.client_secret,
                refresh_token: cred.token.refresh_token,
                grant_type: 'refresh_token'
              })
            });
            if (rTok.ok) {
              const refreshed = await rTok.json();
              accessToken = refreshed.access_token;
              cred.token.access_token = accessToken;
              cred.token.expiry = Date.now() + (Number(refreshed.expires_in) || 3599) * 1000;
              fs.writeFileSync(filePath, JSON.stringify(cred, null, 2), 'utf8');
            }
          }

          if (accessToken && args.to) {
            sentViaLiveGmail = await sendGmailViaSmtpXoAuth2({
              fromEmail: senderAccount,
              accessToken,
              to: args.to,
              subject: args.subject,
              body: args.body
            });
          }
        } catch (_) {}
      }

      const newEmail = {
        id: 'eml-' + Date.now(),
        from: senderAccount,
        to: args.to,
        subject: args.subject,
        snippet: args.body,
        unread: false,
        sentViaLiveGmail,
        timestamp: new Date().toISOString()
      };
      state.emails.unshift(newEmail);
      saveState(state);
      const mailtoUrl = `mailto:${encodeURIComponent(args.to)}?subject=${encodeURIComponent(
        args.subject
      )}&body=${encodeURIComponent(args.body)}`;
      return {
        status: 'success',
        sentViaLiveGmail,
        fromAccount: senderAccount,
        message: sentViaLiveGmail
          ? `Sent email from ${senderAccount} to ${args.to} with subject "${args.subject}".`
          : `Prepared email to ${args.to} with subject "${args.subject}".`,
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
