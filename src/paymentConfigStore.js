// Payment details block shown/sent to students — UPI ID, bank details, a note line.
// Separate small store from paymentStore.js (that one owns the lead-invoice sequence +
// generated PDFs) and from studentPaymentStore.js (the EMI ledger) — this is just the
// editable "who to pay" block plus the formatting/UPI-link helpers both the manual sender
// (Part 1) and any future receipt/statement footer can reuse.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'payment-config.json');

const DEFAULT_CONFIG = {
  upiId: '', accountName: '', bankName: '', accountNumber: '', ifsc: '', note: ''
};

function ensure() {
  if (!fs.existsSync(path.dirname(CONFIG_PATH))) fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
}

export function getConfig() {
  ensure();
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) }; }
  catch (e) { console.error('paymentConfigStore: failed to read config, using defaults:', e.message); return { ...DEFAULT_CONFIG }; }
}

export function updateConfig(partial) {
  const merged = { ...getConfig(), ...partial };
  ensure();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

// Same "INR 25,000" convention as invoicePdf.js — no ₹ glyph dependency here either,
// and this text goes over plain WhatsApp text where the glyph renders fine anyway, but
// keeping the format consistent across every payment-facing document/message in the app
// avoids a jarring "₹" here vs "INR" on the PDF a student gets two minutes later.
function formatAmount(n) {
  return 'INR ' + Number(n).toLocaleString('en-IN');
}

// The formatted text block sent/copied for a given amount (amount optional — omitting it
// just leaves the amount line off, e.g. when sharing bank details before a specific
// installment amount is agreed).
export function formatPaymentBlock(cfg, amount) {
  const lines = ['💳 *Payment Details*', ''];
  if (cfg.upiId) lines.push(`UPI ID: ${cfg.upiId}`);
  if (cfg.accountName) lines.push(`Account Name: ${cfg.accountName}`);
  if (cfg.bankName) lines.push(`Bank: ${cfg.bankName}`);
  if (cfg.accountNumber) lines.push(`Account No: ${cfg.accountNumber}`);
  if (cfg.ifsc) lines.push(`IFSC: ${cfg.ifsc}`);
  if (amount) { lines.push(''); lines.push(`Amount: ${formatAmount(amount)}`); }
  if (cfg.note) { lines.push(''); lines.push(cfg.note); }
  return lines.join('\n');
}

// upi://pay deep link — opens directly in any UPI app in an amount-prefilled payment
// screen. Blank if upiId/accountName aren't configured yet (nothing usable to encode).
export function buildUpiLink(cfg, amount) {
  if (!cfg.upiId) return '';
  const params = new URLSearchParams({ pa: cfg.upiId, pn: cfg.accountName || '', cu: 'INR' });
  if (amount) params.set('am', String(amount));
  return `upi://pay?${params.toString()}`;
}
