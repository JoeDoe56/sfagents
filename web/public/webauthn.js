/**
 * WebAuthn options and credentials as JSON (what @simplewebauthn/server sends
 * and expects), with a fallback for browsers without the JSON helpers.
 */

const b64 = {
  decode(s) {
    const str = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(str, (c) => c.charCodeAt(0)).buffer;
  },
  encode(buf) {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
};

export function creationOptions(json) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  return {
    ...json,
    challenge: b64.decode(json.challenge),
    user: { ...json.user, id: b64.decode(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((c) => ({ ...c, id: b64.decode(c.id) })),
  };
}

export function requestOptions(json) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  return { ...json, challenge: b64.decode(json.challenge), allowCredentials: (json.allowCredentials ?? []).map((c) => ({ ...c, id: b64.decode(c.id) })) };
}

export function credentialJson(cred) {
  try {
    if (typeof cred.toJSON === 'function') return cred.toJSON();
  } catch {
    // some browsers expose toJSON but throw: fall through
  }
  const r = cred.response;
  const out = { id: cred.id, rawId: b64.encode(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults?.() ?? {}, authenticatorAttachment: cred.authenticatorAttachment ?? undefined, response: { clientDataJSON: b64.encode(r.clientDataJSON) } };
  if (r.attestationObject) {
    out.response.attestationObject = b64.encode(r.attestationObject);
    out.response.transports = r.getTransports?.() ?? [];
  } else {
    out.response.authenticatorData = b64.encode(r.authenticatorData);
    out.response.signature = b64.encode(r.signature);
    if (r.userHandle) out.response.userHandle = b64.encode(r.userHandle);
  }
  return out;
}

export const passkeysWork = () => window.isSecureContext && typeof window.PublicKeyCredential === 'function';

export function cancelled(error) {
  return error?.name === 'NotAllowedError' || error?.name === 'AbortError';
}


/** Registers a passkey for the signed-in device. */
export async function registerPasskey(post) {
  const { request, options } = await post('register-options', {});
  const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
  await post('register', { request, response: credentialJson(cred) });
}
