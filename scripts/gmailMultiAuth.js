const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// Official Google-verified Mozilla Thunderbird OAuth2 Mail Client
const CLIENT_ID = '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com';
const CLIENT_SECRET = 'kSmqreRr0qwBWJgbf5Y-PjSU';
const PORT = 8085;
const REDIRECT_URI = `http://localhost:${PORT}/`;
// IMPORTANT: Request ONLY https://mail.google.com/ (no openid/email) so Google makes mail access mandatory instead of an unchecked checkbox!
const SCOPES = 'https://mail.google.com/';

const TOKENS_DIR = path.join(__dirname, '..', 'data', 'gmail-tokens');
if (!fs.existsSync(TOKENS_DIR)) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
}

// Clear any old tokens that lacked https://mail.google.com/ scope
for (const f of fs.readdirSync(TOKENS_DIR)) {
  if (f.endsWith('.json')) {
    try {
      const p = path.join(TOKENS_DIR, f);
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!d.scope || !d.scope.includes('mail.google.com')) {
        fs.unlinkSync(p);
      }
    } catch (_) {}
  }
}

const codeVerifier = crypto.randomBytes(32).toString('base64url');
const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

function buildAuthUrl(loginHint) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    login_hint: loginHint,
    state: loginHint
  });
  return `https://accounts.google.com/o/oauth2/auth?${params.toString()}`;
}

const url1 = buildAuthUrl('yazeedx@gmail.com');
const url2 = buildAuthUrl('yaz@thegauntlet.sa');

console.log('\n=======================================================');
console.log('🔗 DIRECT GMAIL-SCOPE OAUTH LINKS:');
console.log('1) yazeedx@gmail.com:\n' + url1 + '\n');
console.log('2) yaz@thegauntlet.sa:\n' + url2);
console.log('=======================================================\n');

const connectedEmails = new Set();

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, REDIRECT_URI);
    const code = parsed.searchParams.get('code');
    const stateEmail = parsed.searchParams.get('state') || '';
    if (!code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Riz Verified Gmail Auth Server Running</h3>');
      return;
    }

    const tokenRes = await fetch('https://www.googleapis.com/oauth2/v3/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h3>OAuth Error</h3><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
      return;
    }

    const email = stateEmail || 'yazeedx@gmail.com';
    const savePath = path.join(TOKENS_DIR, `${email}.json`);
    fs.writeFileSync(
      savePath,
      JSON.stringify(
        {
          email,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          quota_project_id: 'rizproject-e6d13',
          scope: tokenData.scope || SCOPES,
          token: {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            token_type: tokenData.token_type || 'Bearer',
            expiry: Date.now() + (Number(tokenData.expires_in) || 3599) * 1000
          },
          updated_at: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    );

    connectedEmails.add(email.toLowerCase());
    console.log(`✅ Connected Gmail account: ${email} (scope: ${tokenData.scope}) -> ${savePath}`);

    const bothDone =
      connectedEmails.has('yazeedx@gmail.com') && connectedEmails.has('yaz@thegauntlet.sa');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html>
        <body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:40px;text-align:center;">
          <h2 style="color:#4ade80;">✅ Full Gmail Access Connected for ${email}!</h2>
          <p>${
            bothDone
              ? 'Both yazeedx@gmail.com and yaz@thegauntlet.sa are now connected to Riz! You can close this tab.'
              : 'Now click the button below to connect your second email account!'
          }</p>
          ${
            !connectedEmails.has('yazeedx@gmail.com')
              ? `<p><a href="${url1}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Connect yazeedx@gmail.com →</a></p>`
              : ''
          }
          ${
            !connectedEmails.has('yaz@thegauntlet.sa')
              ? `<p><a href="${url2}" style="display:inline-block;padding:12px 20px;background:#16a34a;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Connect yaz@thegauntlet.sa →</a></p>`
              : ''
          }
        </body>
      </html>
    `);

    if (bothDone) {
      console.log('🎉 Both Gmail accounts connected with full mail.google.com scope! Closing auth server...');
      setTimeout(() => process.exit(0), 1000);
    }
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.writeHead(500);
    res.end('Error: ' + err.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Listening for Direct Gmail OAuth callbacks on ${REDIRECT_URI} ...`);
});
