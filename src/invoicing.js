// Invoice generation + delivery, triggered only from the operator's explicit "confirm
// payment" action in the panel (server.js POST /api/leads/:jid/confirm-payment) — never
// automatically. The bot alerts on a payment screenshot (see leadResponder.js's hasImage
// branch) but deliberately never reaches here on its own; only a human-confirmed amount
// does.
import * as WA from './whatsapp.js';
import * as LS from './leadStore.js';
import * as PS from './paymentStore.js';
import * as G from './google.js';
import { buildInvoicePdf } from './invoicePdf.js';

const googleReady = () => !!process.env.GOOGLE_REFRESH_TOKEN;

function invoiceCaption(invoiceNumber) {
  return `Thank you for your payment! 🙏\nPlease find your official invoice (${invoiceNumber}) attached.\nWelcome to Arya Chandel Academy — batch and joining details will follow shortly.`;
}

// Generates the PDF, saves it locally, best-effort backs it up to Drive, records the
// payment, marks the lead converted, then attempts WhatsApp delivery. The payment record
// and 'converted' state are written BEFORE the WhatsApp send is attempted, deliberately:
// the operator has already confirmed the money was received (that's what triggered this
// call), so that fact shouldn't depend on whether the PDF successfully reaches the lead's
// chat afterward. A failed send is logged and surfaced (waSent:false) so the panel can
// offer a retry via resendInvoice, but it never un-confirms the payment itself — matches
// this subsystem's "never mark delivery as done until confirmed, but don't conflate
// delivery with the underlying business fact" pattern used elsewhere (see deliver() in
// leadResponder.js for the delivery-confirmation half of that pattern).
export async function confirmPayment({ jid, amount }) {
  const lead = LS.getLead(jid);
  if (!lead) throw new Error('Lead not found');
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new Error('Amount must be a positive number');

  const invoiceNumber = PS.nextInvoiceNumber();
  const pdfBuffer = await buildInvoicePdf({ invoiceNumber, phone: lead.phone, pushName: lead.pushName, amount: amt });
  const pdfPath = PS.savePdfToDisk(invoiceNumber, pdfBuffer);

  let driveFileId = null;
  if (googleReady() && process.env.DRIVE_INVOICES_FOLDER_ID) {
    try {
      driveFileId = await G.uploadFile(`${invoiceNumber}.pdf`, pdfBuffer, 'application/pdf', process.env.DRIVE_INVOICES_FOLDER_ID);
    } catch (e) {
      console.error(`Drive upload failed for ${invoiceNumber}:`, e.message);
    }
  }

  PS.recordPayment({ invoiceNumber, jid, phone: lead.phone, pushName: lead.pushName, amount: amt, pdfPath, driveFileId });
  LS.setState(jid, 'converted');
  LS.logEvent({ jid, action: 'payment_confirmed', detail: { invoiceNumber, amount: amt, driveFileId } });

  let waSent = false, waError = null;
  try {
    await WA.sendDocument({ jid, buffer: pdfBuffer, fileName: `${invoiceNumber}.pdf`, caption: invoiceCaption(invoiceNumber) });
    PS.markDelivered(invoiceNumber);
    LS.appendMessage(jid, { dir: 'out', text: `[Invoice ${invoiceNumber} sent]` });
    LS.logEvent({ jid, action: 'invoice_sent', detail: { invoiceNumber } });
    waSent = true;
  } catch (e) {
    waError = e.message;
    LS.logEvent({ jid, action: 'invoice_send_failed', detail: { invoiceNumber, error: e.message } });
    console.error(`Invoice WhatsApp send failed for ${invoiceNumber}:`, e.message);
  }

  return { invoiceNumber, amount: amt, driveFileId, waSent, waError };
}

// Re-attempts delivery of an already-generated invoice — for the panel's "resend" button
// when the original confirmPayment() call generated the PDF/record fine but the
// WhatsApp send itself failed (WhatsApp disconnected, transient error, etc).
export async function resendInvoice(invoiceNumber) {
  const record = PS.getPayment(invoiceNumber);
  if (!record) throw new Error('Invoice not found');
  const buffer = PS.readPdfFromDisk(invoiceNumber);
  await WA.sendDocument({ jid: record.jid, buffer, fileName: `${invoiceNumber}.pdf`, caption: invoiceCaption(invoiceNumber) });
  PS.markDelivered(invoiceNumber);
  LS.logEvent({ jid: record.jid, action: 'invoice_resent', detail: { invoiceNumber } });
  return { ok: true };
}
