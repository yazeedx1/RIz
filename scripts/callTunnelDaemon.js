const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const URL_FILE = path.join(DATA_DIR, 'public-call-url.json');

function saveTunnelUrl(baseUrl) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const payload = {
    baseUrl,
    callUrl: `${baseUrl}/call`,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(URL_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`📞 [Riz KSA HTTPS Voice Call Link Live]: ${payload.callUrl}`);

  // Also sync to Firebase Realtime Database so the latest URL is always persisted in cloud
  fetch('https://rizproject-e6d13-default-rtdb.firebaseio.com/riz_call_tunnel.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function startTunnel() {
  const proc = spawn(
    '/usr/local/bin/cloudflared',
    ['tunnel', '--url', 'http://localhost:3456', '--protocol', 'http2', '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const onChunk = (chunk) => {
    const text = chunk.toString('utf8');
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      saveTunnelUrl(match[0]);
    }
  };

  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);

  proc.on('exit', (code) => {
    console.log(`[Riz Call Tunnel] cloudflared exited (${code}), restarting in 3s...`);
    setTimeout(startTunnel, 3000);
  });
}

startTunnel();
