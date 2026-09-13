// Student payment ledger — data layer for data/student-payments.json. Same
// read-modify-write pattern as store.js/leadStore.js/paymentStore.js, kept as its own
// file for the same reason those are separate: this is PII (name, phone, amounts) with
// its own churn pattern (installments get edited/marked paid far more often than a batch
// or class record changes), and it must never risk corrupting db.json/leads.json on a
// bad write. Distinct from paymentStore.js, which owns the lead-invoice (jid-keyed,
// one-off payment) sequence — this is a standalone EMI-aware ledger keyed by student id,
// not tied to a WhatsApp lead record at all (a student may never have been a "lead").
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { id } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'student-payments.json');

const DEFAULT_DB = {
  receiptCounter: { fy: '', seq: 0 }, // resets to seq:0 whenever the Indian fiscal year (Apr-Mar) advances
  students: {},                        // id -> student record
  reminderQueue: []                    // [{id, studentId, installmentNumber, stage, createdAt, status: pending/sent/dismissed, sentAt}]
};

function ensure() {
  if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
}

export function read() {
  ensure();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

export function write(db) {
  ensure();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export function update(fn) {
  const db = read();
  fn(db);
  write(db);
  return db;
}

// IST has no DST, fixed UTC+5:30 — same offset-arithmetic convention used throughout this
// codebase (leadResponder.js's istHour, paymentStore.js's istYear), not Intl/host TZ.
function istNow() {
  return new Date(Date.now() + 5.5 * 3600 * 1000);
}
export function istDateKey(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

// Indian financial year: Apr 1 - Mar 31, formatted "2026-27". Used for the ACA/<fy>/NNN
// receipt numbering (Part 3) — resets to 001 every April 1 IST, same reset-on-rollover
// idea as paymentStore.js's yearly invoice counter, just fiscal-year instead of calendar.
export function fiscalYearKey(d = istNow()) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(); // istNow() already shifted to IST wall-clock
  const startY = m >= 3 ? y : y - 1; // April is month index 3
  return `${startY}-${String((startY + 1) % 100).padStart(2, '0')}`;
}

export function nextReceiptNumber() {
  let num;
  update(d => {
    const fy = fiscalYearKey();
    if (!d.receiptCounter || d.receiptCounter.fy !== fy) d.receiptCounter = { fy, seq: 0 };
    d.receiptCounter.seq++;
    num = `ACA/${fy}/${String(d.receiptCounter.seq).padStart(3, '0')}`;
  });
  return num;
}

function addMonths(dateISO, n) {
  const d = new Date(dateISO);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

// Even split with any paisa-rounding remainder folded into the LAST installment, so the
// sum of installment amounts always equals totalAmount exactly — never left to drift by a
// few rupees across N installments. The operator can still edit any individual amount
// afterward for a genuinely uneven split (spec: "allow uneven splits").
function buildEvenInstallments(totalAmount, count, startDate) {
  const base = Math.floor(totalAmount / count);
  const installments = [];
  let allocated = 0;
  for (let i = 1; i <= count; i++) {
    const amount = i === count ? totalAmount - allocated : base;
    allocated += amount;
    installments.push({
      number: i, amount, dueDate: addMonths(startDate, i - 1),
      status: 'pending', paidOn: null, receiptNo: null, screenshotRef: null
    });
  }
  return installments;
}

// ---------- student CRUD ----------
export function getStudent(id_) {
  return read().students[id_] || null;
}

export function getAllStudents() {
  return Object.values(read().students).sort((a, b) => b.createdAt - a.createdAt);
}

export function findStudentByPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return Object.values(read().students).find(s => s.phone === digits) || null;
}

export function createStudent({ name, phone, batch, course, language = 'en', totalAmount, planType, emiCount, emiStart, notes = '' }) {
  const digits = (phone || '').replace(/\D/g, '');
  const amount = Number(totalAmount);
  if (!name || !digits || !amount || amount <= 0) throw new Error('name, phone, and a positive totalAmount are required');
  if (!['full', 'emi'].includes(planType)) throw new Error('planType must be "full" or "emi"');

  let installments;
  if (planType === 'emi') {
    const count = Number(emiCount);
    if (!count || count < 2) throw new Error('emiCount must be 2 or more for an EMI plan');
    const start = emiStart || istDateKey();
    installments = buildEvenInstallments(amount, count, start);
  } else {
    installments = [{ number: 1, amount, dueDate: istDateKey(), status: 'pending', paidOn: null, receiptNo: null, screenshotRef: null }];
  }

  const student = {
    id: id(), name, phone: digits, batch: batch || '', course: course || '', language,
    totalAmount: amount, planType, emiCount: planType === 'emi' ? Number(emiCount) : 1,
    installments, notes, pendingScreenshot: null,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  update(d => { d.students[student.id] = student; });
  return student;
}

// Whole-object-merge for top-level fields (name/batch/course/notes/language/totalAmount) —
// installments are edited separately via updateInstallment, never blindly overwritten here,
// so an edit to "notes" can never accidentally clobber an in-progress installment array.
export function updateStudent(id_, partial) {
  let updated;
  update(d => {
    const s = d.students[id_];
    if (!s) throw new Error('Student not found');
    const { installments, id: _id, createdAt, ...rest } = partial;
    Object.assign(s, rest);
    s.updatedAt = Date.now();
    updated = s;
  });
  return updated;
}

export function updateInstallment(id_, number, partial) {
  let updated;
  update(d => {
    const s = d.students[id_];
    if (!s) throw new Error('Student not found');
    const inst = s.installments.find(i => i.number === Number(number));
    if (!inst) throw new Error('Installment not found');
    Object.assign(inst, partial);
    s.updatedAt = Date.now();
    updated = inst;
  });
  return updated;
}

export function getNextPendingInstallment(id_) {
  const s = getStudent(id_);
  if (!s) return null;
  return s.installments.find(i => i.status !== 'paid') || null;
}

// Marks one installment paid and rolls amountPaid forward. Does NOT generate/send the
// receipt itself — that's src/studentPayments.js#markInstallmentPaid's job, which calls
// this as its data-layer step and then builds the PDF from the returned totals.
export function recordInstallmentPaid(id_, number, { amount, paidOn = Date.now(), receiptNo, screenshotRef = null, source = 'manual' } = {}) {
  let result;
  update(d => {
    const s = d.students[id_];
    if (!s) throw new Error('Student not found');
    const inst = s.installments.find(i => i.number === Number(number));
    if (!inst) throw new Error('Installment not found');
    if (inst.status === 'paid') throw new Error('Installment already marked paid');
    inst.status = 'paid';
    inst.paidOn = paidOn;
    inst.receiptNo = receiptNo;
    inst.screenshotRef = screenshotRef;
    inst.paidAmount = amount != null ? Number(amount) : inst.amount;
    inst.source = source;
    s.updatedAt = Date.now();
    if (s.pendingScreenshot && s.pendingScreenshot.installmentNumber === Number(number)) s.pendingScreenshot = null;
    result = { student: s, installment: inst };
  });
  return result;
}

export function flagScreenshotForConfirmation(id_, installmentNumber, { receivedAt = Date.now(), sourceJid = null } = {}) {
  update(d => {
    const s = d.students[id_];
    if (!s) throw new Error('Student not found');
    s.pendingScreenshot = { installmentNumber, receivedAt, sourceJid };
    s.updatedAt = Date.now();
  });
}

export function clearScreenshotFlag(id_) {
  update(d => {
    const s = d.students[id_];
    if (s) { s.pendingScreenshot = null; s.updatedAt = Date.now(); }
  });
}

// ---------- computed ledger view ----------
// amountPaid/balance are never stored — derived fresh from installments every read, so
// they can't drift out of sync with the installment array (the actual source of truth).
export function withComputed(student) {
  if (!student) return student;
  const today = istDateKey();
  // "overdue" is derived, not stored — stays in sync automatically as the calendar
  // moves forward, instead of needing a cron just to flip a stored status field.
  const installments = student.installments.map(i =>
    i.status === 'pending' && i.dueDate < today ? { ...i, status: 'overdue' } : i
  );
  const amountPaid = installments.filter(i => i.status === 'paid').reduce((sum, i) => sum + (i.paidAmount ?? i.amount), 0);
  const balance = student.totalAmount - amountPaid;
  const nextPending = installments.find(i => i.status !== 'paid') || null;
  const overdueCount = installments.filter(i => i.status === 'overdue').length;
  return { ...student, installments, amountPaid, balance, nextDueDate: nextPending?.dueDate || null, overdueCount };
}

// ---------- reminder queue ----------
export function getReminderQueue() {
  return read().reminderQueue.filter(r => r.status === 'pending');
}

export function findReminderQueueItem(studentId, installmentNumber, stage) {
  return read().reminderQueue.find(r => r.studentId === studentId && r.installmentNumber === installmentNumber && r.stage === stage) || null;
}

export function addReminderQueueItem({ studentId, installmentNumber, stage }) {
  const item = { id: id(), studentId, installmentNumber, stage, createdAt: Date.now(), status: 'pending', sentAt: null };
  update(d => { d.reminderQueue.push(item); });
  return item;
}

export function getReminderQueueItem(id_) {
  return read().reminderQueue.find(r => r.id === id_) || null;
}

export function markReminderSent(id_) {
  update(d => {
    const r = d.reminderQueue.find(x => x.id === id_);
    if (r) { r.status = 'sent'; r.sentAt = Date.now(); }
  });
}

export function dismissReminder(id_) {
  update(d => {
    const r = d.reminderQueue.find(x => x.id === id_);
    if (r) r.status = 'dismissed';
  });
}

// Every reminder stage already queued/sent for one installment, regardless of current
// status — used by the daily scan to decide what's left to escalate, not just what to
// queue next (see src/studentPayments.js#scanForReminders).
export function getStagesSeenFor(studentId, installmentNumber) {
  return read().reminderQueue.filter(r => r.studentId === studentId && r.installmentNumber === installmentNumber).map(r => r.stage);
}

// ---------- CSV export (Part 5) ----------
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv() {
  const rows = getAllStudents().map(withComputed);
  const header = ['Name', 'Phone', 'Batch', 'Course', 'Plan', 'Total (INR)', 'Paid (INR)', 'Balance (INR)', 'Next Due Date', 'Overdue Installments', 'Notes'];
  const lines = [header.join(',')];
  for (const s of rows) {
    lines.push([
      s.name, s.phone, s.batch, s.course, s.planType, s.totalAmount, s.amountPaid, s.balance,
      s.nextDueDate || '', s.overdueCount, s.notes
    ].map(csvEscape).join(','));
  }
  return lines.join('\n');
}
