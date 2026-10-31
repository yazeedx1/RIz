const tls = require('tls');

function buildXoAuth2Token(email, accessToken) {
  const authStr = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(authStr, 'utf8').toString('base64');
}

function decodeMimeWords(str) {
  if (!str) return '';
  return String(str).replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf8');
      }
      if (encoding.toUpperCase() === 'Q') {
        const qText = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
        return Buffer.from(qText, 'binary').toString('utf8');
      }
    } catch (_) {}
    return text;
  });
}

/**
 * Fetches recent emails from Gmail via native TLS IMAP (imap.gmail.com:993) using XOAUTH2.
 * Works with any `https://mail.google.com/` OAuth token (such as Mozilla Thunderbird's verified client).
 */
function fetchGmailViaImapXoAuth2({ email, accessToken, query = '', maxResults = 6 }) {
  return new Promise((resolve) => {
    const xoauth2 = buildXoAuth2Token(email, accessToken);
    const socket = tls.connect({ host: 'imap.gmail.com', port: 993, servername: 'imap.gmail.com' });
    let buffer = '';
    let step = 'greeting';
    let totalMessages = 0;
    let settled = false;

    const finish = (items) => {
      if (settled) return;
      settled = true;
      try {
        socket.write('A99 LOGOUT\r\n');
        socket.destroy();
      } catch (_) {}
      resolve(items || []);
    };

    const timer = setTimeout(() => finish([]), 8500);

    socket.on('error', () => {
      clearTimeout(timer);
      finish([]);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      if (step === 'greeting' && buffer.includes('\r\n')) {
        buffer = '';
        step = 'auth';
        socket.write(`A01 AUTHENTICATE XOAUTH2 ${xoauth2}\r\n`);
        return;
      }

      if (step === 'auth' && /A01 (OK|NO|BAD)/i.test(buffer)) {
        if (!/A01 OK/i.test(buffer)) {
          clearTimeout(timer);
          return finish([]);
        }
        buffer = '';
        step = 'select';
        socket.write('A02 SELECT INBOX\r\n');
        return;
      }

      if (step === 'select' && /A02 (OK|NO|BAD)/i.test(buffer)) {
        const existsMatch = buffer.match(/\*\s+(\d+)\s+EXISTS/i);
        totalMessages = existsMatch ? parseInt(existsMatch[1], 10) : 0;
        buffer = '';
        if (totalMessages === 0) {
          clearTimeout(timer);
          return finish([]);
        }

        if (query && query.toLowerCase() === 'unread') {
          step = 'search';
          socket.write('A03 SEARCH UNSEEN\r\n');
        } else if (query) {
          const safeQ = query.replace(/["\\]/g, '');
          step = 'search';
          socket.write(`A03 SEARCH TEXT "${safeQ}"\r\n`);
        } else {
          const startSeq = Math.max(1, totalMessages - maxResults + 1);
          step = 'fetch';
          socket.write(
            `A04 FETCH ${startSeq}:${totalMessages} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])\r\n`
          );
        }
        return;
      }

      if (step === 'search' && /A03 (OK|NO|BAD)/i.test(buffer)) {
        const searchLine = buffer.match(/\*\s+SEARCH([^\r\n]*)/i);
        const ids = searchLine
          ? searchLine[1]
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .slice(-maxResults)
          : [];
        buffer = '';
        if (ids.length === 0) {
          clearTimeout(timer);
          return finish([]);
        }
        step = 'fetch';
        socket.write(
          `A04 FETCH ${ids.join(',')} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])\r\n`
        );
        return;
      }

      if (step === 'fetch' && /A04 (OK|NO|BAD)/i.test(buffer)) {
        clearTimeout(timer);
        const raw = buffer;
        const blocks = raw.split(/\*\s+\d+\s+FETCH\s+\(/i).slice(1);
        const parsedEmails = [];

        for (const blk of blocks) {
          const unread = !/\\Seen/i.test(blk);
          const fromMatch = blk.match(/^From:\s*(.+)$/im);
          const subjMatch = blk.match(/^Subject:\s*(.+)$/im);
          const dateMatch = blk.match(/^Date:\s*(.+)$/im);
          const from = decodeMimeWords(fromMatch ? fromMatch[1].trim() : 'Unknown Sender');
          const subject = decodeMimeWords(subjMatch ? subjMatch[1].trim() : '(No Subject)');
          const date = dateMatch ? dateMatch[1].trim() : '';
          parsedEmails.push({
            id: `imap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            account: email,
            from,
            subject,
            date,
            snippet: `${subject} — from ${from}`,
            unread
          });
        }

        return finish(parsedEmails.reverse());
      }
    });
  });
}

/**
 * Sends an email via Gmail TLS SMTP (smtp.gmail.com:465) using XOAUTH2.
 */
function sendGmailViaSmtpXoAuth2({ fromEmail, accessToken, to, subject, body }) {
  return new Promise((resolve) => {
    const xoauth2 = buildXoAuth2Token(fromEmail, accessToken);
    const socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });
    let step = 'greeting';
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.write('QUIT\r\n');
        socket.destroy();
      } catch (_) {}
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), 8500);
    socket.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });

    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (step === 'greeting' && /^220/m.test(text)) {
        step = 'ehlo';
        socket.write('EHLO localhost\r\n');
      } else if (step === 'ehlo' && /^250 /m.test(text)) {
        step = 'auth';
        socket.write(`AUTH XOAUTH2 ${xoauth2}\r\n`);
      } else if (step === 'auth' && /^235/m.test(text)) {
        step = 'mailfrom';
        socket.write(`MAIL FROM:<${fromEmail}>\r\n`);
      } else if (step === 'mailfrom' && /^250/m.test(text)) {
        step = 'rcptto';
        socket.write(`RCPT TO:<${to}>\r\n`);
      } else if (step === 'rcptto' && /^250/m.test(text)) {
        step = 'data';
        socket.write('DATA\r\n');
      } else if (step === 'data' && /^354/m.test(text)) {
        step = 'done';
        const mime = [
          `From: ${fromEmail}`,
          `To: ${to}`,
          `Subject: ${subject || 'Message from Yazeed via Riz'}`,
          'Content-Type: text/plain; charset="UTF-8"',
          '',
          body || '',
          '.',
          ''
        ].join('\r\n');
        socket.write(mime);
      } else if (step === 'done' && /^250/m.test(text)) {
        clearTimeout(timer);
        finish(true);
      } else if (/^[45]\d\d/m.test(text)) {
        clearTimeout(timer);
        finish(false);
      }
    });
  });
}

module.exports = {
  fetchGmailViaImapXoAuth2,
  sendGmailViaSmtpXoAuth2
};
