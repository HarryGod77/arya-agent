// Terminal chat simulator for the lead-responder's full reply routing.
// No WhatsApp, no data/leads.json writes — mirrors src/leadResponder.js#handleInboundMessage's
// actual order (local reply engine first, Gemini only as fallback) so you can read how
// replies sound, and confirm which path answered, before this ever touches a real chat.
// Only touches data/reply-rotation.json (variant rotation state, keyed under a clearly-
// fake "chat-test-simulator" jid) — never leads.json or any real contact's data.
// Run: npm run chat:test
import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { classifyIntent, generateReply } from '../src/gemini.js';
import { detectIntent, pickVariant, getIntentMeta } from '../src/replyEngine.js';

const SIM_JID = 'chat-test-simulator';
const STATES = ['new', 'informed', 'interested', 'silent', 'converted'];
let leadState = 'new';
let hasGreetedBefore = false;
const messages = [];

const rl = readline.createInterface({ input: stdin, output: stdout });

console.log('--- Lead-responder chat simulator ---');
console.log('Type a message as the lead would.');
console.log('Commands: /state <new|informed|interested|silent|converted>  /reset  /exit\n');

// Async-iterator consumption (`for await...of rl`) rather than repeated `rl.question()`
// calls — with piped/redirected stdin, successive question() calls can race against
// already-buffered lines when a loop iteration resolves synchronously (as the local
// reply engine's match path now does), silently dropping input and hanging. Iterating
// the interface directly doesn't have that race, and still prompts correctly for
// interactive typing.
const prompt = () => process.stdout.write(`LEAD [${leadState}]> `);
prompt();

async function handleLine(line) {
  if (!line) return;

  if (line === '/reset') {
    messages.length = 0;
    leadState = 'new';
    hasGreetedBefore = false;
    console.log('(conversation reset)\n');
    return;
  }
  if (line.startsWith('/state ')) {
    const s = line.slice(7).trim();
    if (STATES.includes(s)) { leadState = s; console.log(`(stage set to: ${leadState})\n`); }
    else console.log(`(unknown state — use one of: ${STATES.join(', ')})\n`);
    return;
  }

  messages.push({ dir: 'in', text: line });

  try {
    // 1) Local reply engine first — exactly like handleInboundMessage. Zero Gemini calls
    // when this matches.
    const local = detectIntent(line, { hasGreetedBefore });
    if (local) {
      const variant = pickVariant(local.intent, local.language, SIM_JID);
      const { escalate } = getIntentMeta(local.intent);
      console.log(`  [LOCAL: ${local.intent}, confidence ${local.confidence}, language ${local.language}, variant #${variant?.index}]`);
      if (!variant) { console.log('  -> matched but no variant found (bug) — would fall through.\n'); return; }

      console.log(`BOT> ${variant.text}`);
      if (escalate) console.log(`  [ESCALATE: local_intent:${local.intent}]`);
      console.log();

      messages.push({ dir: 'out', text: variant.text });
      if (local.intent.startsWith('greeting_')) hasGreetedBefore = true;
      else if (leadState === 'new') leadState = 'informed';
      return;
    }

    // 2) Gemini fallback — nothing local matched confidently.
    const { intent, quotaExhausted: classifyQuotaExhausted } = await classifyIntent(messages.slice(-20));
    console.log(`  [GEMINI FALLBACK — classified: ${intent}${classifyQuotaExhausted ? ' — CLASSIFY QUOTA EXHAUSTED, fell back to unclear' : ''}]`);

    if (intent === 'not_related') { console.log('  -> bot stays silent.\n'); return; }
    if (intent === 'unclear') { console.log('  -> bot stays silent, would notify operator on Note-to-Self.\n'); return; }

    const { reply, escalate, escalateReason, quotaExhausted } = await generateReply({ messages: messages.slice(-20), leadState, intent });

    if (quotaExhausted) {
      console.log('  -> REPLY QUOTA EXHAUSTED: bot sends nothing, would notify operator to handle manually.\n');
      return;
    }

    console.log(`BOT> ${reply}`);
    if (escalate) console.log(`  [ESCALATE: ${escalateReason || 'unspecified'}]`);
    console.log();

    messages.push({ dir: 'out', text: reply });
    // A bare greeting doesn't count as "informed" yet — only real engagement does.
    if (intent === 'greeting') hasGreetedBefore = true;
    else if (leadState === 'new') leadState = 'informed';
  } catch (e) {
    console.error('  Error:', e.message, '\n');
  }
}

for await (const raw of rl) {
  const line = raw.trim();
  if (line === '/exit') break;
  await handleLine(line);
  prompt();
}

rl.close();
console.log('\nbye.');
