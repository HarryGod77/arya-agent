// Terminal chat simulator for the lead-responder's Gemini logic.
// No WhatsApp, no data/leads.json writes — pure classify+reply loop so you can read
// how replies sound before this ever touches a real chat. Run: npm run chat:test
import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { classifyIntent, generateReply } from '../src/gemini.js';

const STATES = ['new', 'informed', 'interested', 'silent', 'converted'];
let leadState = 'new';
const messages = [];

const rl = readline.createInterface({ input: stdin, output: stdout });

console.log('--- Lead-responder chat simulator ---');
console.log('Type a message as the lead would.');
console.log('Commands: /state <new|informed|interested|silent|converted>  /reset  /exit\n');

while (true) {
  let raw;
  try { raw = await rl.question(`LEAD [${leadState}]> `); }
  catch { break; } // stdin closed (EOF / piped input / Ctrl+D) — exit quietly instead of crashing
  const line = raw.trim();
  if (!line) continue;
  if (line === '/exit') break;

  if (line === '/reset') {
    messages.length = 0;
    leadState = 'new';
    console.log('(conversation reset)\n');
    continue;
  }
  if (line.startsWith('/state ')) {
    const s = line.slice(7).trim();
    if (STATES.includes(s)) { leadState = s; console.log(`(stage set to: ${leadState})\n`); }
    else console.log(`(unknown state — use one of: ${STATES.join(', ')})\n`);
    continue;
  }

  messages.push({ dir: 'in', text: line });

  try {
    const { intent, quotaExhausted: classifyQuotaExhausted } = await classifyIntent(messages.slice(-20));
    console.log(`  [classified: ${intent}${classifyQuotaExhausted ? ' — CLASSIFY QUOTA EXHAUSTED, fell back to unclear' : ''}]`);

    if (intent === 'not_related') { console.log('  -> bot stays silent.\n'); continue; }
    if (intent === 'unclear') { console.log('  -> bot stays silent, would notify operator on Note-to-Self.\n'); continue; }

    const { reply, escalate, escalateReason, quotaExhausted } = await generateReply({ messages: messages.slice(-20), leadState, intent });

    if (quotaExhausted) {
      console.log('  -> REPLY QUOTA EXHAUSTED: bot sends nothing, would notify operator to handle manually.\n');
      continue;
    }

    console.log(`BOT> ${reply}`);
    if (escalate) console.log(`  [ESCALATE: ${escalateReason || 'unspecified'}]`);
    console.log();

    messages.push({ dir: 'out', text: reply });
    // A bare greeting doesn't count as "informed" yet — only real engagement does.
    if (leadState === 'new' && intent !== 'greeting') leadState = 'informed';
  } catch (e) {
    console.error('  Error:', e.message, '\n');
  }
}

rl.close();
console.log('bye.');
