// Generates the numbered PDF invoice buffer. Kept separate from invoicing.js so the
// layout can change without touching the orchestration (Drive upload, WhatsApp send,
// payment record) around it.
//
// Deliberately uses "INR" instead of the ₹ glyph: pdfkit's built-in standard-14 fonts
// (Helvetica etc.) use WinAnsiEncoding, which does not include the Rupee sign — it would
// render as a missing-glyph box unless a Unicode font (e.g. Noto Sans) were bundled and
// registered. Not worth the added deploy weight for one symbol; revisit only if the
// operator specifically wants the ₹ glyph on the printed invoice.
import PDFDocument from 'pdfkit';

const BUSINESS_NAME = 'Arya Chandel Consultancy';
const COURSE_NAME = 'Mentalism & Hypnosis Masterclass';

function formatAmount(n) {
  return 'INR ' + Number(n).toLocaleString('en-IN');
}

function formatDate(d) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

export function buildInvoicePdf({ invoiceNumber, phone, pushName, amount, date = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#000').text(BUSINESS_NAME);
    doc.fontSize(10).fillColor('#555').text(COURSE_NAME);
    doc.moveDown(1.5);

    doc.fillColor('#000').fontSize(16).text('INVOICE', { align: 'right' });
    doc.fontSize(10).text(`Invoice No: ${invoiceNumber}`, { align: 'right' });
    doc.text(`Date: ${formatDate(date)}`, { align: 'right' });
    doc.moveDown(1.5);

    doc.fontSize(11).text('Billed To:');
    doc.text(pushName || 'Customer');
    doc.text(`+${phone}`);
    doc.moveDown(1.5);

    const tableTop = doc.y;
    doc.font('Helvetica-Bold').fontSize(11);
    doc.text('Description', 50, tableTop);
    doc.text('Amount', 400, tableTop, { width: 100, align: 'right' });
    doc.moveTo(50, doc.y + 16).lineTo(500, doc.y + 16).stroke();
    doc.moveDown(1.5);

    doc.font('Helvetica').fontSize(11);
    const rowY = doc.y;
    doc.text(`${COURSE_NAME} — Course Fee`, 50, rowY, { width: 330 });
    doc.text(formatAmount(amount), 400, rowY, { width: 100, align: 'right' });
    doc.moveDown(2);

    doc.moveTo(50, doc.y).lineTo(500, doc.y).stroke();
    doc.moveDown(0.75);
    const totalY = doc.y;
    doc.font('Helvetica-Bold').fontSize(12);
    doc.text('Total Paid', 50, totalY, { width: 330 });
    doc.text(formatAmount(amount), 400, totalY, { width: 100, align: 'right' });
    doc.moveDown(2.5);

    doc.font('Helvetica').fontSize(10).fillColor('#555');
    doc.text('Payment Method: UPI / Bank Transfer');
    doc.text('Status: PAID');
    doc.moveDown(2);

    doc.fontSize(9).text('Thank you for enrolling with Arya Chandel Academy!', 50, doc.y, { align: 'center', width: 450 });

    doc.end();
  });
}

// Per-installment payment receipt (Part 3) — distinct from buildInvoicePdf above, which is
// the one-off lead-conversion invoice. A receipt is issued every time a ledgered
// installment is marked paid, so it always shows running totals (this payment, total paid
// so far, balance remaining, next due date), not just the single amount.
export function buildReceiptPdf({ receiptNo, studentName, phone, course, amount, totalPaid, totalAmount, balance, nextDueDate, date = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#000').text(BUSINESS_NAME);
    doc.fontSize(10).fillColor('#555').text(course || COURSE_NAME);
    doc.moveDown(1.5);

    doc.fillColor('#000').fontSize(16).text('PAYMENT RECEIPT', { align: 'right' });
    doc.fontSize(10).text(`Receipt No: ${receiptNo}`, { align: 'right' });
    doc.text(`Date: ${formatDate(date)}`, { align: 'right' });
    doc.moveDown(1.5);

    doc.fontSize(11).text('Received From:');
    doc.text(studentName || 'Student');
    if (phone) doc.text(`+${phone}`);
    doc.moveDown(1.5);

    const tableTop = doc.y;
    doc.font('Helvetica-Bold').fontSize(11);
    doc.text('Description', 50, tableTop);
    doc.text('Amount', 400, tableTop, { width: 100, align: 'right' });
    doc.moveTo(50, doc.y + 16).lineTo(500, doc.y + 16).stroke();
    doc.moveDown(1.5);

    doc.font('Helvetica').fontSize(11);
    const rowY = doc.y;
    doc.text('Installment Payment', 50, rowY, { width: 330 });
    doc.text(formatAmount(amount), 400, rowY, { width: 100, align: 'right' });
    doc.moveDown(2);

    doc.moveTo(50, doc.y).lineTo(500, doc.y).stroke();
    doc.moveDown(0.75);

    const summary = [
      ['This Payment', formatAmount(amount)],
      ['Total Paid So Far', formatAmount(totalPaid)],
      ['Course Fee', formatAmount(totalAmount)],
      ['Balance Remaining', formatAmount(balance)],
    ];
    for (const [label, value] of summary) {
      const y = doc.y;
      const bold = label === 'Balance Remaining';
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 11);
      doc.text(label, 50, y, { width: 330 });
      doc.text(value, 400, y, { width: 100, align: 'right' });
      doc.moveDown(bold ? 1 : 0.6);
    }

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(10).fillColor('#555');
    doc.text(`Next Due Date: ${nextDueDate || 'None — fully paid'}`);
    doc.moveDown(2);

    doc.fontSize(9).text('Thank you for your payment!', 50, doc.y, { align: 'center', width: 450 });

    doc.end();
  });
}

// Full account statement (Part 3) — every installment, what's paid/pending, dates, and a
// running balance table, for the "Send statement" action.
export function buildStatementPdf({ studentName, phone, course, totalAmount, amountPaid, balance, installments, date = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#000').text(BUSINESS_NAME);
    doc.fontSize(10).fillColor('#555').text(course || COURSE_NAME);
    doc.moveDown(1.5);

    doc.fillColor('#000').fontSize(16).text('ACCOUNT STATEMENT', { align: 'right' });
    doc.fontSize(10).text(`Date: ${formatDate(date)}`, { align: 'right' });
    doc.moveDown(1.5);

    doc.fontSize(11).text('Student:');
    doc.text(studentName || 'Student');
    if (phone) doc.text(`+${phone}`);
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(11);
    doc.text(`Total Fee: ${formatAmount(totalAmount)}   |   Paid: ${formatAmount(amountPaid)}   |   Balance: ${formatAmount(balance)}`);
    doc.moveDown(1.5);

    const colX = { num: 50, due: 90, amount: 220, status: 320, paidOn: 400 };
    const headerY = doc.y;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('#', colX.num, headerY);
    doc.text('Due Date', colX.due, headerY);
    doc.text('Amount', colX.amount, headerY);
    doc.text('Status', colX.status, headerY);
    doc.text('Paid On', colX.paidOn, headerY);
    doc.moveTo(50, doc.y + 14).lineTo(500, doc.y + 14).stroke();
    doc.moveDown(1.2);

    doc.font('Helvetica').fontSize(10);
    let running = 0;
    for (const inst of installments) {
      if (inst.status === 'paid') running += (inst.paidAmount ?? inst.amount);
      const y = doc.y;
      doc.text(String(inst.number), colX.num, y);
      doc.text(inst.dueDate, colX.due, y);
      doc.text(formatAmount(inst.amount), colX.amount, y);
      doc.text(inst.status, colX.status, y);
      doc.text(inst.paidOn ? formatDate(new Date(inst.paidOn)) : '-', colX.paidOn, y);
      doc.moveDown(0.9);
    }

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(500, doc.y).stroke();
    doc.moveDown(0.75);
    doc.font('Helvetica-Bold').fontSize(11);
    doc.text(`Running Total Paid: ${formatAmount(running)}   |   Balance Remaining: ${formatAmount(totalAmount - running)}`);
    doc.moveDown(2);

    doc.font('Helvetica').fontSize(9).fillColor('#555').text('Please reach out if any of the above needs correcting.', { align: 'center' });

    doc.end();
  });
}
