// Part 1 — manual "send payment details" tool in the panel. Sends the configured UPI/bank
// block plus an auto-generated UPI QR to any number the operator types in. Distinct from
// src/invoicing.js (which sends a generated invoice PDF after a confirmed payment) — this
// fires BEFORE payment, to give a lead/student something to pay against.
import QRCode from 'qrcode';
import * as WA from './whatsapp.js';
import * as PCS from './paymentConfigStore.js';
import { outboundEnabled, dailyOutboundCap } from './leadResponder.js';
import * as LS from './leadStore.js';

// Text + UPI link only, no send — backs the panel's "Copy" button and the pre-send preview.
export function previewPaymentDetails(amount) {
  const cfg = PCS.getConfig();
  return {
    text: PCS.formatPaymentBlock(cfg, amount),
    upiLink: PCS.buildUpiLink(cfg, amount)
  };
}

// Reuses the exact same outbound kill-switch + daily cap + counter as the AUTO-mode lead
// responder (src/leadResponder.js's deliver()) — per spec, this is "the existing outbound
// cap", not a second one. A blocked send returns { sent:false, reason } rather than
// throwing, matching every other best-effort WhatsApp send in this codebase.
export async function sendPaymentDetails({ phone, amount }) {
  const jid = WA.phoneToJid(phone);
  if (!jid) return { sent: false, reason: 'invalid_phone' };

  if (!outboundEnabled()) return { sent: false, reason: 'outbound_disabled' };
  if (LS.getOutboundSentToday() >= dailyOutboundCap()) return { sent: false, reason: 'daily_cap' };

  const cfg = PCS.getConfig();
  const text = PCS.formatPaymentBlock(cfg, amount);
  const upiLink = PCS.buildUpiLink(cfg, amount);

  try {
    if (upiLink) {
      const qrBuffer = await QRCode.toBuffer(upiLink, { type: 'png', margin: 1, width: 400 });
      await WA.sendImage({ jid, buffer: qrBuffer, caption: text });
    } else {
      await WA.sendText({ jid, text }); // no UPI ID configured yet — nothing to attach a QR to
    }
    LS.incrementOutboundSentToday();
    return { sent: true };
  } catch (e) {
    console.error('Payment details send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}
