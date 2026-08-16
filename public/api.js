// API/data layer — Harry's Control Room.
// Pulled out of app.js so PASS and the fetch wrapper live in one place. Login here is
// just the network call + storing the passphrase — wiring it to the gate's DOM (button
// click, showing/hiding #app) stays in app.js, since that's presentational and belongs
// with the rest of the shell work in Phase 1, not this data layer.
let PASS = '';

export function getPass() {
  return PASS;
}

export function setPass(p) {
  PASS = p;
}

// api('/api/batches') or api('/api/batches/1', { method: 'PUT', body: JSON.stringify({...}) })
// Throws on a non-OK response so callers can catch it — pair with ui.js's
// showErrorBanner() at the call site instead of a silent catch {}.
export async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-pass': PASS, ...(opts.headers || {}) }
  });
  if (!res.ok) {
    let message = String(res.status);
    try { message = (await res.json()).error || message; } catch { /* non-JSON error body */ }
    throw new Error(message);
  }
  return res.json();
}

// login('the-passphrase') -> true/false. On success, stores it for api() to use.
export async function login(password) {
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  }).then(res => res.json());
  if (r.ok) setPass(password);
  return !!r.ok;
}
