const assert = require('assert');
const { detectRizTrigger, handleIncomingWhatsAppMessage, resetAllSessions } = require('../src/whatsappEngine');
const { executeTool } = require('../src/tools');
const { createServer } = require('../src/server');

async function runTests() {
  console.log('Running Riz AI Assistant Test Suite (Dynamic AI + Real Tools)...\n');
  resetAllSessions();

  // 1. Trigger word boundary tests
  const defaultCfg = {
    whatsappEnabled: true,
    replyInGroups: true,
    replyInDMs: true,
    requireTriggerInDMs: true,
    triggerWords: ['Riz', 'hey riz', '@riz']
  };

  const ignored1 = detectRizTrigger('Hey everyone, are we going to lunch?', 'group', defaultCfg);
  assert.strictEqual(ignored1.triggered, false, 'Should ignore message without Riz');

  const ignoredSubstring = detectRizTrigger('Please authorize the horizon deployment', 'group', defaultCfg);
  assert.strictEqual(ignoredSubstring.triggered, false, 'Should NOT false-trigger on "authorize" or "horizon"');

  const triggered1 = detectRizTrigger('Hey Riz, what is on my schedule today?', 'group', defaultCfg);
  assert.strictEqual(triggered1.triggered, true, 'Should trigger on "Hey Riz"');

  console.log('✓ Trigger word boundary detection passed');

  // 2. 3-Stage Password ("blacky") + Open Conversation Flow with Dynamic AI Replies
  const chatId = 'test-chat-1@s.whatsapp.net';

  // Step A: Message without "Riz" while locked -> Ignored
  const stepA = await handleIncomingWhatsAppMessage({
    chatId,
    senderName: 'Sarah',
    chatType: 'dm',
    messageText: 'Hello there!'
  });
  assert.strictEqual(stepA.triggered, false);
  assert.strictEqual(stepA.sessionState, 'locked');

  // Step B: Trigger "Hey Riz" -> Asks for password dynamically
  const stepB = await handleIncomingWhatsAppMessage({
    chatId,
    senderName: 'Sarah',
    chatType: 'dm',
    messageText: 'Hey Riz'
  });
  assert.strictEqual(stepB.triggered, true);
  assert.strictEqual(stepB.sessionState, 'awaiting_password');
  assert.ok(stepB.reply.length > 5, 'Should return dynamic AI password prompt');

  // Step C: Wrong password -> Rejected, stays awaiting_password
  const stepC = await handleIncomingWhatsAppMessage({
    chatId,
    senderName: 'Sarah',
    chatType: 'dm',
    messageText: '12345'
  });
  assert.strictEqual(stepC.triggered, true);
  assert.strictEqual(stepC.sessionState, 'awaiting_password');
  assert.ok(stepC.reply.length > 5);

  // Step D: Correct password "blacky" -> Unlocks Open Conversation Mode!
  const stepD = await handleIncomingWhatsAppMessage({
    chatId,
    senderName: 'Sarah',
    chatType: 'dm',
    messageText: 'blacky'
  });
  assert.strictEqual(stepD.triggered, true);
  assert.strictEqual(stepD.sessionState, 'unlocked');
  assert.ok(stepD.reply.length > 5);

  // Step E: Open Conversation -> Ask "When am I going to be available?"
  const stepE = await handleIncomingWhatsAppMessage({
    chatId,
    senderName: 'Sarah',
    chatType: 'dm',
    messageText: 'When am I going to be available today?'
  });
  assert.strictEqual(stepE.triggered, true);
  assert.strictEqual(stepE.sessionState, 'unlocked');
  assert.strictEqual(stepE.toolCalls[0].name, 'check_availability_and_free_slots');

  // Step F: Open Conversation -> Ask "Where am I right now?"
  const stepF = await handleIncomingWhatsAppMessage({
    chatId,
    senderName: 'Sarah',
    chatType: 'dm',
    messageText: 'Where am I right now?'
  });
  assert.strictEqual(stepF.triggered, true);
  assert.strictEqual(stepF.toolCalls[0].name, 'get_owner_profile_and_location');

  // Step G: Open Conversation -> Ask about real codebase files
  const stepG = await handleIncomingWhatsAppMessage({
    chatId,
    senderName: 'Sarah',
    chatType: 'dm',
    messageText: 'What code files are in my project?'
  });
  assert.strictEqual(stepG.triggered, true);
  assert.strictEqual(stepG.toolCalls[0].name, 'inspect_codebase_and_files');
  assert.ok(stepG.toolCalls[0].result.entries.some((e) => e.name === 'server.js'));

  // Step H: Open Conversation -> Ask about Git / GitHub
  const stepH = await handleIncomingWhatsAppMessage({
    chatId,
    senderName: 'Sarah',
    chatType: 'dm',
    messageText: 'Check my git status and github repos'
  });
  assert.strictEqual(stepH.triggered, true);
  assert.strictEqual(stepH.toolCalls[0].name, 'github_and_git_operations');

  // Step I: Lock session -> Returns to locked
  const stepI = await handleIncomingWhatsAppMessage({
    chatId,
    senderName: 'Sarah',
    chatType: 'dm',
    messageText: 'lock'
  });
  assert.strictEqual(stepI.sessionState, 'locked');

  console.log('✓ Dynamic AI Security Gate & Real Tool Integration tests passed');

  // 3. HTTP Server & Webhook integration tests
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const stateRes = await fetch(`${baseUrl}/api/state`);
  assert.strictEqual(stateRes.status, 200);
  const stateJson = await stateRes.json();
  assert.strictEqual(stateJson.config.assistantName, 'Riz');
  assert.strictEqual(stateJson.config.accessPassword, 'blacky');
  assert.strictEqual(stateJson.calendarEvents.length, 0, 'Should have zero fake sample calendar events');
  assert.strictEqual(stateJson.emails.length, 0, 'Should have zero fake sample emails');

  server.close();
  console.log('✓ HTTP API & Clean Real State tests passed');
  console.log('\nALL TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
