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
