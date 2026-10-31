const fs = require('fs');
const path = require('path');
const { loadState, saveState } = require('../src/configStore');

const NETLIFY_CLIENT_ID = 'd6f37de6614df7ae58664cfca524744d73807a377f5ee71f1a254f78412e3750';
const DATA_DIR = path.join(__dirname, '..', 'data');
const TICKET_FILE = path.join(DATA_DIR, 'netlify-pending-ticket.json');
const TOKEN_FILE = path.join(DATA_DIR, 'netlify-token.json');
const ENV_FILE = path.join(__dirname, '..', '.env');

async function startNetlifyTicketAuth() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const res = await fetch(`https://api.netlify.com/api/v1/oauth/tickets?client_id=${NETLIFY_CLIENT_ID}`, {
    method: 'POST'
  });
  if (!res.ok) {
    throw new Error(`Failed to create Netlify ticket: ${res.status}`);
  }
  const ticket = await res.json();
  const ticketId = ticket.id;
  fs.writeFileSync(
    TICKET_FILE,
    JSON.stringify({ id: ticketId, createdAtMs: Date.now() }, null, 2),
    'utf8'
  );

  const authUrl = `https://app.netlify.com/authorize?response_type=ticket&ticket=${ticketId}`;
  console.log(`NETLIFY_AUTH_URL=${authUrl}`);

  const start = Date.now();
  while (Date.now() - start < 30 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const checkRes = await fetch(`https://api.netlify.com/api/v1/oauth/tickets/${ticketId}`);
      if (!checkRes.ok) continue;
      const status = await checkRes.json();
      if (status && status.authorized) {
        const exRes = await fetch(
          `https://api.netlify.com/api/v1/oauth/tickets/${ticketId}/exchange`,
          { method: 'POST' }
        );
        if (exRes.ok) {
          const exData = await exRes.json();
          if (exData && exData.access_token) {
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(exData, null, 2), 'utf8');
            let envText = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
            if (envText.includes('NETLIFY_AUTH_TOKEN=')) {
              envText = envText.replace(/NETLIFY_AUTH_TOKEN=.*/g, `NETLIFY_AUTH_TOKEN=${exData.access_token}`);
            } else {
              envText = envText.trimEnd() + `\nNETLIFY_AUTH_TOKEN=${exData.access_token}\n`;
            }
            fs.writeFileSync(ENV_FILE, envText, 'utf8');

            const state = loadState();
            state.config.netlifyToken = exData.access_token;
            saveState(state);
            console.log('NETLIFY_AUTHORIZED_SUCCESS=true');
            process.exit(0);
          }
        }
      }
    } catch (_) {}
  }
}

startNetlifyTicketAuth().catch((err) => {
  console.error(err);
  process.exit(1);
});
