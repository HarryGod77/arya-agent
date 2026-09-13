// Regression test for the "Gemini is down => no replies go out" bug: exercises the REAL
// production inbound handler (src/leadResponder.js#handleInboundMessage), not a
// reimplementation of its logic — scripts/test-reply.js is a simulator that mirrors the
// routing by hand, which is exactly the kind of divergence that let a real wiring bug go
// unnoticed before. This script imports and calls the actual function Baileys'
// 'messages.upsert' listener dispatches to in src/whatsapp.js.
//
// Deliberately does NOT `import 'dotenv/config'` and explicitly deletes
// GEMINI_API_KEY from process.env before calling anything — src/gemini.js's
// callGeminiJSON() throws synchronously when the key is missing, which is a real,
// zero-network-call way to force every Gemini call down the same failure path a live
// 429/quota-exhaustion or network outage takes (src/leadResponder.js only special-cases
// GeminiQuotaExhaustedError inside gemini.js itself; anything else propagates up to the
// try/catch this test is here to verify).
//
// Asserts:
//   1) classifyIntent's failure was caught (not left to crash/hang the message).
//   2) The lead still gets a reply: the local reply engine (src/replyEngine.js) is
//      invoked with the 'fallback_gemini_unavailable' intent and actually picks a variant
//      (data/reply-engine-log.jsonl gets a real match, independent of whether the
//      outbound WhatsApp send itself succeeds — this dev environment has no live Baileys
//      connection, so the send is expected to fail; what matters is that the reply text
//      was generated/selected at all, not silently skipped).
//   3) The unified 'inbound_routed' diagnostic log line reports geminiCalled: true and
//      the fallback intent.
//
// Run: node scripts/test-gemini-fallback.js
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_CLASSIFY_MODEL;
delete process.env.GEMINI_REPLY_MODEL;

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleInboundMessage } from '../src/leadResponder.js';
import * as LS from '../src/leadStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEAD_LOG_PATH = path.join(__dirname, '..', 'data', 'lead-log.jsonl');
const REPLY_ENGINE_LOG_PATH = path.join(__dirname, '..', 'data', 'reply-engine-log.jsonl');

// Not a real WhatsApp number — never collides with an actual contact/lead.
const TEST_JID = 'test-gemini-fallback@s.whatsapp.net';
// Deliberately generic English, on-topic-ish, but confirmed (see below) to match none of
// data/replies.json's 86 local intents, so the real handler is forced to fall through to
// the Gemini classify step where the injected failure lives.
const TEST_MESSAGE = 'Can you tell me something more about how this whole thing generally works out for people';

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function cleanup() {
  LS.update(db => { delete db.leads[TEST_JID]; });
}

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  PASS - ${label}`);
  else { console.error(`  FAIL - ${label}`); failures++; }
}

async function main() {
  console.log('--- Gemini-unavailable fallback test (real handleInboundMessage) ---');
  console.log(`GEMINI_API_KEY set? ${!!process.env.GEMINI_API_KEY} (must be false for this test to be meaningful)\n`);

  cleanup(); // in case a previous run was interrupted before its own cleanup ran

  await handleInboundMessage({
    jid: TEST_JID,
    phone: TEST_JID.split('@')[0],
    pushName: 'Gemini Fallback Test',
    text: TEST_MESSAGE
  });

  const leadLog = readJsonl(LEAD_LOG_PATH).filter(l => l.jid === TEST_JID);
  const replyEngineLog = readJsonl(REPLY_ENGINE_LOG_PATH).filter(l => l.jid === TEST_JID);

  const classified = leadLog.find(l => l.action === 'classified');
  const routed = [...leadLog].reverse().find(l => l.action === 'inbound_routed' && l.detail?.geminiCalled);
  const localMatch = replyEngineLog.find(l => l.intent === 'fallback_gemini_unavailable');

  check('a "classified" event was logged for the inbound message', !!classified);
  check('classifyIntent\'s failure was caught, not left uncaught', !!classified?.detail?.failed);
  check('the local reply engine matched the "fallback_gemini_unavailable" intent', !!localMatch);
  check('a real variant was picked (not a no-variant bug)', typeof localMatch?.variantIndex === 'number');
  check('the unified inbound_routed log reports Gemini was called', !!routed);
  check('inbound_routed reports the fallback intent', routed?.detail?.intent === 'fallback_gemini_unavailable');

  cleanup();

  if (failures) {
    console.error(`\n${failures} check(s) failed — Gemini failure is still blocking a local reply.`);
    process.exit(1);
  }
  console.log('\nAll checks passed — a Gemini outage no longer leaves the lead without a reply.');
}

main().catch(e => {
  console.error('Test crashed:', e);
  cleanup();
  process.exit(1);
});
