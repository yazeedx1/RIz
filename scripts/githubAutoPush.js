const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Official GitHub CLI OAuth App Client ID for device flow
const CLIENT_ID = '178c6fc778ccc68e1d6a';
const ENV_PATH = path.join(__dirname, '..', '.env');
const PROJECT_DIR = path.join(__dirname, '..');

async function startGitHubAutoPush() {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: 'repo read:user'
    })
  });

  const data = await res.json();
  if (!data.device_code) {
    console.error('Failed to initiate GitHub device flow:', data);
    process.exit(1);
  }

  console.log('\n========================================================');
  console.log('🐙 GITHUB 1-CLICK AUTO-PUSH READY');
  console.log(`👉 Open: ${data.verification_uri}`);
  console.log(`🔑 Enter Code: ${data.user_code}`);
  console.log('========================================================\n');
  console.log('Waiting for you to authorize in browser... Will auto-push to https://github.com/yazeedx1/RIz immediately!');

  const intervalMs = (data.interval || 5) * 1000 + 500;
  const maxAttempts = 120;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const pollRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: data.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    });

    const pollData = await pollRes.json();
    if (pollData.access_token) {
      const token = pollData.access_token;
      console.log('✅ GitHub authorized! Saving token to .env and pushing to yazeedx1/RIz...');

      let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
      envContent = envContent
        .split('\n')
        .filter((line) => !line.startsWith('GITHUB_TOKEN='))
        .join('\n');
      envContent = `${envContent.trim()}\nGITHUB_TOKEN=${token}\n`;
      fs.writeFileSync(ENV_PATH, envContent, 'utf8');

      // Push to GitHub
      const remoteUrl = `https://yazeedx1:${token}@github.com/yazeedx1/RIz.git`;
      execSync(`git push "${remoteUrl}" main --force`, {
        cwd: PROJECT_DIR,
        stdio: 'inherit'
      });

      console.log('🚀 Successfully pushed Riz AI Assistant to https://github.com/yazeedx1/RIz !');
      process.exit(0);
    }

    if (pollData.error && pollData.error !== 'authorization_pending' && pollData.error !== 'slow_down') {
      console.error('GitHub Device Auth Error:', pollData);
      process.exit(1);
    }
  }
}

startGitHubAutoPush().catch((err) => {
  console.error(err);
  process.exit(1);
});
