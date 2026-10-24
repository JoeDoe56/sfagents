/**
 * The sign-in page: the access token printed by `sfagents web`, or a passkey
 * this device (or a synced password manager) registered earlier. After a
 * token sign-in it offers to add a passkey, then goes on to the app.
 */

import { cancelled, credentialJson, passkeysWork, registerPasskey, requestOptions } from './webauthn.js';

const $ = (id) => document.getElementById(id);

/** Where to go after signing in: a path on this server only. */
function nextUrl() {
  const n = new URLSearchParams(location.search).get('next') || '/';
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}

async function api(action, body) {
  const res = await fetch(`/api/auth/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ------------------------------------------------------------ the page

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

async function passkeySignIn() {
  const btn = $('passkeyBtn');
  btn.disabled = true;
  showError($('error'), '');
  try {
    const { request, options } = await api('passkey-options', {});
    const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
    await api('passkey', { request, response: credentialJson(cred) });
    location.replace(nextUrl());
  } catch (error) {
    if (!cancelled(error)) showError($('error'), error.message);
  } finally {
    btn.disabled = false;
  }
}

async function addPasskey() {
  const btn = $('addPasskey');
  btn.disabled = true;
  showError($('offerError'), '');
  try {
    await registerPasskey(api);
    location.replace(nextUrl());
  } catch (error) {
    if (!cancelled(error)) showError($('offerError'), error.message);
  } finally {
    btn.disabled = false;
  }
}

async function start() {
  let status;
  try {
    status = await api('status');
  } catch (error) {
    showError($('error'), error.message);
    return;
  }
  if (status.signedIn) {
    location.replace(nextUrl());
    return;
  }
  const canPasskey = passkeysWork() && status.secureContext;
  if (canPasskey && status.passkeys > 0) {
    $('passkeyBtn').hidden = false;
    $('orLine').hidden = false;
  }
  $('passkeyBtn').addEventListener('click', passkeySignIn);
  $('tokenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('tokenBtn');
    btn.disabled = true;
    showError($('error'), '');
    try {
      await api('login', { token: $('token').value.trim() });
      $('token').value = '';
      if (canPasskey) {
        $('signin').hidden = true;
        $('offer').hidden = false;
        $('addPasskey').focus();
      } else {
        location.replace(nextUrl());
      }
    } catch (error) {
      showError($('error'), error.message);
      $('token').select();
    } finally {
      btn.disabled = false;
    }
  });
  $('addPasskey').addEventListener('click', addPasskey);
  $('skip').addEventListener('click', () => location.replace(nextUrl()));
  if (!canPasskey || status.passkeys === 0) $('token').focus();
}

start();
