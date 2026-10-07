// =============================================================================
// Hybrid encryption, browser side.
// =============================================================================
// Everything personal — the member names and the written answers — is encrypted
// here with the instructor's public key before it reaches Firestore. Google
// stores a blob it has no key for.
//
// Needs a secure context: https, or localhost. On plain http over a LAN address
// window.crypto.subtle is undefined and this throws on purpose rather than
// sending anything in the clear.

const ALG = { name: 'RSA-OAEP', hash: 'SHA-256' };
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

export function cryptoAvailable() {
  return !!(window.isSecureContext && window.crypto && window.crypto.subtle);
}

let pubKeyPromise = null;
function publicKey(jwk) {
  if (!pubKeyPromise) {
    pubKeyPromise = crypto.subtle.importKey('jwk', jwk, ALG, false, ['encrypt']);
  }
  return pubKeyPromise;
}

/** obj -> { k, iv, ct }, all base64. */
export async function encryptPayload(obj, publicJwk) {
  if (!cryptoAvailable()) {
    throw new Error('This page needs https. Nothing was sent.');
  }
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey,
    new TextEncoder().encode(JSON.stringify(obj)));
  const rawAes = await crypto.subtle.exportKey('raw', aesKey);
  const k = await crypto.subtle.encrypt(ALG, await publicKey(publicJwk), rawAes);
  return { k: b64(k), iv: b64(iv), ct: b64(ct) };
}

// -----------------------------------------------------------------------------
// Each group makes its own AES key at join and keeps it in this browser. The key
// travels to the instructor inside the RSA blob, so the worker can encrypt the
// feedback with it. Nobody else — Google included — can read that feedback.
// -----------------------------------------------------------------------------
const KEY_LS = 'gm_groupkey_v1';
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function groupKeyB64() {
  let k = localStorage.getItem(KEY_LS);
  if (!k) {
    const key = await crypto.subtle.generateKey({ name:'AES-GCM', length:256 }, true, ['encrypt','decrypt']);
    k = b64(await crypto.subtle.exportKey('raw', key));
    localStorage.setItem(KEY_LS, k);
  }
  return k;
}

/** { iv, ct } written by the worker -> the original object. */
export async function decryptWithGroupKey(blob) {
  const raw = unb64(await groupKeyB64());
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}
