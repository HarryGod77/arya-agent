// Part 1 — manual "send payment details" tool in the panel. Sends the configured UPI/bank
// block plus an auto-generated UPI QR to any number the operator types in. Distinct from
// src/invoicing.js (which sends a generated invoice PDF after a confirmed payment) — this
// fires BEFORE payment, to give a lead/student something to pay against.
import QRCode from 'qrcode';
import * as WA from './whatsapp.js';
import * as PCS from './paymentConfigStore.js';
import { outboundEnabled, dailyInitiatedCap } from './leadResponder.js';
import * as LS from './leadStore.js';

// Text + UPI link only, no send — backs the panel's "Copy" button and the pre-send preview.
export function previewPaymentDetails(amount) {
  const cfg = PCS.getConfig();
  return {
    text: PCS.formatPaymentBlock(cfg, amount),
    upiLink: PCS.buildUpiLink(cfg, amount)
  };
}

// Reuses the exact same outbound kill-switch as the AUTO-mode lead responder
// (src/leadResponder.js's deliver()). A "send payment details" click is normally a
// bot/operator-INITIATED message (the whole point is giving someone something to pay
// against before they've necessarily asked again), so it's capped by DAILY_INITIATED_CAP
// by default — but if this phone number happens to have messaged us in the last 24h, it's
// counted as a reply instead and isn't capped, via the same hasRecentInboundMessage rule
// every proactive sender in this app uses now. A blocked send returns { sent:false,
// reason } rather than throwing, matching every other best-effort WhatsApp send here.
export async function sendPaymentDetails({ phone, amount }) {
  const jid = WA.phoneToJid(phone);
  if (!jid) return { sent: false, reason: 'invalid_phone' };

  if (!outboundEnabled()) return { sent: false, reason: 'outbound_disabled' };
  const isReply = WA.hasRecentInboundMessage(jid);
  if (!isReply && LS.getInitiatedSentToday() >= dailyInitiatedCap()) return { sent: false, reason: 'daily_cap' };

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
    if (isReply) LS.incrementReplySentToday();
    else LS.incrementInitiatedSentToday();
    console.log(`Payment details sent to ${phone} — counted as ${isReply ? 'reply' : 'initiated'}.`);
    return { sent: true };
  } catch (e) {
    console.error('Payment details send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}
