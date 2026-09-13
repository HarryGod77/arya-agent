// Orchestrates the student payment ledger (Parts 2-4): CRUD passthroughs to
// studentPaymentStore.js for plain data edits, plus the side-effecting flows (receipt
// generation + WhatsApp delivery, screenshot-match confirmation, reminder scan/send) that
// need more than a single store write. Mirrors src/invoicing.js's split from
// src/paymentStore.js — same reasoning: keep the data layer pure, keep Drive/WhatsApp/PDF
// orchestration here.
import * as WA from './whatsapp.js';
import * as SPS from './studentPaymentStore.js';
import * as G from './google.js';
import * as RE from './replyEngine.js';
import { outboundEnabled } from './leadResponder.js';
import { buildReceiptPdf, buildStatementPdf } from './invoicePdf.js';

const googleReady = () => !!process.env.GOOGLE_REFRESH_TOKEN;

// ---------- CRUD passthroughs (Part 2) ----------
export function addStudent(data) {
  return SPS.createStudent(data);
}

export function editStudent(id, partial) {
  return SPS.updateStudent(id, partial);
}

export function editInstallment(id, number, partial) {
  return SPS.updateInstallment(id, number, partial);
}

export function getStudentDetail(id) {
  const s = SPS.getStudent(id);
  return s ? SPS.withComputed(s) : null;
}

export function getAllStudents() {
  return SPS.getAllStudents().map(SPS.withComputed);
}

// ---------- receipts (Part 3) ----------
// Shared by the panel's manual "Mark paid" button and the confirmed-screenshot flow below
// — both end up here so a receipt is generated + sent identically either way. amount
// defaults to the installment's own amount; only overridden when the operator enters a
// different figure at confirm time (e.g. a partial payment).
export async function markInstallmentPaid(studentId, installmentNumber, { amount, screenshotRef = null, source = 'manual' } = {}) {
  const student = SPS.getStudent(studentId);
  if (!student) throw new Error('Student not found');
  const inst = student.installments.find(i => i.number === Number(installmentNumber));
  if (!inst) throw new Error('Installment not found');
  const paidAmount = amount != null ? Number(amount) : inst.amount;
  if (!paidAmount || paidAmount <= 0) throw new Error('Amount must be a positive number');

  const receiptNo = SPS.nextReceiptNumber();
  const { student: updated } = SPS.recordInstallmentPaid(studentId, installmentNumber, {
    amount: paidAmount, receiptNo, screenshotRef, source
  });
  const computed = SPS.withComputed(updated);

  const pdfBuffer = await buildReceiptPdf({
    receiptNo, studentName: computed.name, phone: computed.phone, course: computed.course,
    amount: paidAmount, totalPaid: computed.amountPaid, totalAmount: computed.totalAmount,
    balance: computed.balance, nextDueDate: computed.nextDueDate
  });

  let driveFileId = null;
  if (googleReady() && process.env.DRIVE_INVOICES_FOLDER_ID) {
    try { driveFileId = await G.uploadFile(`${receiptNo.replace(/\//g, '-')}.pdf`, pdfBuffer, 'application/pdf', process.env.DRIVE_INVOICES_FOLDER_ID); }
    catch (e) { console.error(`Drive upload failed for receipt ${receiptNo}:`, e.message); }
  }

  let waSent = false, waError = null;
  try {
    const jid = WA.phoneToJid(computed.phone);
    const caption = `Payment received — thank you! 🙏\nReceipt ${receiptNo} attached.\nBalance remaining: INR ${computed.balance.toLocaleString('en-IN')}${computed.nextDueDate ? `\nNext due date: ${computed.nextDueDate}` : ''}`;
    await WA.sendDocument({ jid, buffer: pdfBuffer, fileName: `${receiptNo.replace(/\//g, '-')}.pdf`, caption });
    waSent = true;
  } catch (e) {
    waError = e.message;
    console.error(`Receipt WhatsApp send failed for ${receiptNo}:`, e.message);
  }

  return { receiptNo, driveFileId, waSent, waError, student: computed };
}

// ---------- screenshot matching (Part 3) ----------
// Called from leadResponder.js's hasImage branch when the sender's phone matches a known
// student — flags their next unpaid installment for the operator's confirmation. Never
// auto-marks paid: amounts in screenshots are unreliable, so the operator must type the
// real amount in the panel before markInstallmentPaid actually runs.
export function matchScreenshotToStudent(phone) {
  const student = SPS.findStudentByPhone(phone);
  if (!student) return null;
  const next = SPS.getNextPendingInstallment(student.id);
  if (!next) return null; // fully paid already — nothing to flag
  SPS.flagScreenshotForConfirmation(student.id, next.number, { receivedAt: Date.now() });
  return { studentId: student.id, name: student.name, installmentNumber: next.number };
}

// Operator's explicit confirm action for a flagged screenshot — same "never auto-mark
// paid" guarantee as src/invoicing.js#confirmPayment: the amount always comes from the
// operator typing it into the panel, never parsed out of the image.
export async function confirmScreenshotPayment(studentId, installmentNumber, amount) {
  return markInstallmentPaid(studentId, installmentNumber, { amount, screenshotRef: 'confirmed_from_alert', source: 'screenshot' });
}

// ---------- statements (Part 3) ----------
export async function generateStatement(studentId) {
  const student = SPS.getStudent(studentId);
  if (!student) throw new Error('Student not found');
  const computed = SPS.withComputed(student);
  return buildStatementPdf({
    studentName: computed.name, phone: computed.phone, course: computed.course,
    totalAmount: computed.totalAmount, amountPaid: computed.amountPaid, balance: computed.balance,
    installments: computed.installments
  });
}

export async function sendStatement(studentId) {
  const student = SPS.getStudent(studentId);
  if (!student) throw new Error('Student not found');
  const pdfBuffer = await generateStatement(studentId);
  const jid = WA.phoneToJid(student.phone);
  await WA.sendDocument({ jid, buffer: pdfBuffer, fileName: `statement-${student.name.replace(/\s+/g, '_')}.pdf`, caption: 'Your account statement is attached. 📄' });
  return { ok: true };
}

// ---------- reminders (Part 4, approval-gated) ----------
// Schedule: 3 days before due date, on the due date, 2 days after — then stop. If still
// unpaid after the "2 days after" reminder has actually gone out, escalate to the
// operator instead of messaging the student again. Everything here only ever QUEUES —
// nothing sends until the operator clicks Send in the panel (see sendReminderQueueItem).
function daysUntilDue(dueDateISO, todayISO) {
  const due = Date.parse(dueDateISO + 'T00:00:00Z');
  const today = Date.parse(todayISO + 'T00:00:00Z');
  return Math.round((due - today) / 86400000);
}

// Threshold windows rather than exact-day equality, so a missed cron tick (server
// downtime, restart) still catches up on the next run instead of silently skipping a
// stage forever — each stage is still recorded exactly once per installment via
// getStagesSeenFor, so catching up never double-queues.
export function scanForReminders() {
  const today = SPS.istDateKey();
  let queued = 0, escalated = 0;

  for (const student of SPS.getAllStudents()) {
    for (const inst of student.installments) {
      if (inst.status === 'paid') continue;
      const seen = SPS.getStagesSeenFor(student.id, inst.number);
      const d = daysUntilDue(inst.dueDate, today);

      if (d <= 3 && d > 0 && !seen.includes('before')) {
        SPS.addReminderQueueItem({ studentId: student.id, installmentNumber: inst.number, stage: 'before' });
        queued++;
      } else if (d <= 0 && d > -2 && !seen.includes('due')) {
        SPS.addReminderQueueItem({ studentId: student.id, installmentNumber: inst.number, stage: 'due' });
        queued++;
      } else if (d <= -2 && !seen.includes('overdue')) {
        SPS.addReminderQueueItem({ studentId: student.id, installmentNumber: inst.number, stage: 'overdue' });
        queued++;
      } else if (d < -2 && seen.includes('overdue') && !seen.includes('escalated')) {
        // The "2 days after" reminder stage has already been queued/sent and the
        // installment is STILL unpaid — stop messaging the student, alert the operator
        // instead. Recorded via the same seen-stages mechanism so this fires exactly once.
        const item = SPS.addReminderQueueItem({ studentId: student.id, installmentNumber: inst.number, stage: 'escalated' });
        SPS.markReminderSent(item.id); // this "stage" is an alert, not a student-facing send — nothing to approve
        WA.sendToOperatorAlert(
          `⚠️ OVERDUE PAYMENT — ${student.name} (${student.phone})\nInstallment #${inst.number} of INR ${inst.amount.toLocaleString('en-IN')} was due ${inst.dueDate} and is still unpaid. Reminders have been sent — this needs your follow-up.`
        ).catch(e => console.error('Overdue escalation alert failed:', e.message));
        escalated++;
      }
    }
  }
  return { queued, escalated };
}

// Fills the picked variant's remaining tokens — {{course_fee_current}}/{{manager_name}}/etc
// are already substituted by RE.pickVariant's own fillTemplates() call; these are the
// student/installment-specific ones that only this module knows.
function fillReminderTokens(text, student, inst) {
  const computed = SPS.withComputed(student);
  const tokens = {
    '{{name}}': student.name, '{{course}}': student.course || 'the course',
    '{{amount}}': Number(inst.amount).toLocaleString('en-IN'),
    '{{due_date}}': inst.dueDate, '{{installment_number}}': String(inst.number),
    '{{emi_count}}': String(student.emiCount || 1),
    '{{balance}}': Number(computed.balance).toLocaleString('en-IN')
  };
  let out = text;
  for (const [token, value] of Object.entries(tokens)) out = out.split(token).join(value);
  return out;
}

export function getReminderQueueWithDetails() {
  return SPS.getReminderQueue().map(item => {
    const student = SPS.getStudent(item.studentId);
    const inst = student?.installments.find(i => i.number === item.installmentNumber);
    return { ...item, student: student ? SPS.withComputed(student) : null, installment: inst || null };
  }).filter(i => i.student && i.installment); // drop orphans (e.g. installment edited away)
}

// Approval-gated send — the ONLY path that actually messages a student for a reminder,
// fired exclusively from the operator's explicit "Send" click (server.js's
// POST /api/payment-reminders/:id/send). Respects the same OUTBOUND_ENABLED kill switch
// as every other proactive send in this app; the account got restricted once for
// automated outbound, so a human click doesn't bypass that final safety net.
export async function sendReminderQueueItem(id) {
  if (!outboundEnabled()) return { sent: false, reason: 'outbound_disabled' };

  const item = SPS.getReminderQueueItem(id);
  if (!item || item.status !== 'pending') return { sent: false, reason: 'not_found' };

  const student = SPS.getStudent(item.studentId);
  const inst = student?.installments.find(i => i.number === item.installmentNumber);
  if (!student || !inst) { SPS.dismissReminder(id); return { sent: false, reason: 'not_found' }; }
  if (inst.status === 'paid') { SPS.dismissReminder(id); return { sent: false, reason: 'already_paid' }; }

  const variant = RE.pickVariant('payment_reminder', student.language === 'hi' ? 'hi' : 'en', WA.phoneToJid(student.phone));
  if (!variant) return { sent: false, reason: 'no_variant' };
  const text = fillReminderTokens(variant.text, student, inst);

  try {
    await WA.sendWithTypingDelay({ jid: WA.phoneToJid(student.phone), text });
    SPS.markReminderSent(id);
    return { sent: true };
  } catch (e) {
    console.error('Reminder send failed:', e.message);
    return { sent: false, reason: e.message }; // leave queued — operator can retry
  }
}

export function dismissReminderItem(id) {
  SPS.dismissReminder(id);
  return { ok: true };
}

// ---------- dashboard (Part 5) ----------
// All figures derived fresh from the ledger every call, same "never store what can drift"
// principle as SPS.withComputed's balance/amountPaid.
export function getDashboard() {
  const students = getAllStudents(); // already withComputed
  const monthKey = SPS.istDateKey().slice(0, 7); // YYYY-MM

  let collectedThisMonth = 0, totalOutstanding = 0, overdueInstallments = 0;
  let emiCount = 0, fullCount = 0;

  for (const s of students) {
    totalOutstanding += s.balance;
    if (s.planType === 'emi') emiCount++; else fullCount++;
    for (const inst of s.installments) {
      if (inst.status === 'overdue') overdueInstallments++;
      if (inst.status === 'paid' && inst.paidOn && SPS.istDateKey(new Date(inst.paidOn)).slice(0, 7) === monthKey) {
        collectedThisMonth += (inst.paidAmount ?? inst.amount);
      }
    }
  }

  return { collectedThisMonth, totalOutstanding, overdueInstallments, emiCount, fullCount, studentCount: students.length };
}
