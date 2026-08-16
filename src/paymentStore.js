// Payment/invoice data layer — separate from db.json and leads.json for the same reason
// leadStore.js is separate: this is PII (names, phones, amounts) with its own churn
// pattern, and a bad write here should never risk corrupting batch or lead data.
// Same read-modify-write pattern as store.js/leadStore.js. Generated PDFs live on disk
// under data/invoices/, one file per invoice number.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAYMENTS_PATH = path.join(__dirname, '..', 'data', 'payments.json');
const INVOICES_DIR = path.join(__dirname, '..', 'data', 'invoices');

const DEFAULT_DB = {
  invoiceCounter: { year: 0, seq: 0 }, // resets to seq:0 whenever the IST year advances
  payments: []                          // [{invoiceNumber, jid, phone, pushName, amount, confirmedAt, pdfPath, driveFileId, waSent, waSentAt}]
};

function ensure() {
  if (!fs.existsSync(path.dirname(PAYMENTS_PATH))) fs.mkdirSync(path.dirname(PAYMENTS_PATH), { recursive: true });
  if (!fs.existsSync(PAYMENTS_PATH)) fs.writeFileSync(PAYMENTS_PATH, JSON.stringify(DEFAULT_DB, null, 2));
  if (!fs.existsSync(INVOICES_DIR)) fs.mkdirSync(INVOICES_DIR, { recursive: true });
}

function read() {
  ensure();
  return JSON.parse(fs.readFileSync(PAYMENTS_PATH, 'utf-8'));
}

function write(db) {
  ensure();
  fs.writeFileSync(PAYMENTS_PATH, JSON.stringify(db, null, 2));
}

function update(fn) {
  const db = read();
  fn(db);
  write(db);
  return db;
}

// IST has no DST, fixed UTC+5:30 — same offset-arithmetic approach as leadResponder.js's
// istHour, avoids depending on the host's ICU/locale data.
const istYear = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600 * 1000).getUTCFullYear();

// Yearly-reset sequential numbering: INV-2026-0001, INV-2026-0002, ... INV-2027-0001.
// Allocating a number is not the same as confirming delivery — once issued it's issued,
// even if the WhatsApp send that follows later fails (see invoicing.js#confirmPayment).
export function nextInvoiceNumber() {
  let num;
  update(d => {
    const year = istYear();
    if (!d.invoiceCounter || d.invoiceCounter.year !== year) d.invoiceCounter = { year, seq: 0 };
    d.invoiceCounter.seq++;
    num = `INV-${year}-${String(d.invoiceCounter.seq).padStart(4, '0')}`;
  });
  return num;
}

export function savePdfToDisk(invoiceNumber, buffer) {
  ensure();
  const p = path.join(INVOICES_DIR, `${invoiceNumber}.pdf`);
  fs.writeFileSync(p, buffer);
  return p;
}

export function readPdfFromDisk(invoiceNumber) {
  return fs.readFileSync(path.join(INVOICES_DIR, `${invoiceNumber}.pdf`));
}

// Recorded BEFORE the WhatsApp send is attempted — the payment itself (operator-confirmed
// amount) is a fact independent of whether the PDF successfully reaches the lead's chat.
// waSent starts false and only flips via markDelivered, once delivery is actually confirmed.
export function recordPayment({ invoiceNumber, jid, phone, pushName, amount, pdfPath, driveFileId }) {
  update(d => {
    d.payments.push({
      invoiceNumber, jid, phone, pushName: pushName || '', amount,
      confirmedAt: Date.now(), pdfPath, driveFileId: driveFileId || null,
      waSent: false, waSentAt: null
    });
  });
}

export function markDelivered(invoiceNumber) {
  update(d => {
    const p = d.payments.find(x => x.invoiceNumber === invoiceNumber);
    if (p) { p.waSent = true; p.waSentAt = Date.now(); }
  });
}

export function getPayment(invoiceNumber) {
  return read().payments.find(p => p.invoiceNumber === invoiceNumber) || null;
}

export function getAllPayments() {
  return read().payments.slice().sort((a, b) => b.confirmedAt - a.confirmedAt);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv() {
  const rows = getAllPayments();
  const header = ['Invoice Number', 'Date (IST)', 'Phone', 'Name', 'Amount (INR)', 'WhatsApp Sent', 'Drive File ID'];
  const lines = [header.join(',')];
  for (const p of rows) {
    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(p.confirmedAt);
    lines.push([p.invoiceNumber, dateStr, p.phone, p.pushName, p.amount, p.waSent ? 'yes' : 'no', p.driveFileId || ''].map(csvEscape).join(','));
  }
  return lines.join('\n');
}
