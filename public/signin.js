import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
} from '/vendor/simplewebauthn/index.js';

const form = document.getElementById('signin-form');
const submit = form.querySelector('button[type="submit"]');
const passkeyButton = document.getElementById('passkey-button');
const status = document.getElementById('status');

function showStatus(message, kind) {
  status.textContent = message;
  status.className = `status ${kind}`;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

// Messages passed from other pages, e.g. /signin?signed-out
const params = new URLSearchParams(location.search);
if (params.has('signed-out')) showStatus("You've signed out.", 'success');
if (params.has('registered')) {
  showStatus("Almost done: we've emailed you a link. Confirm your address, then sign in.", 'success');
}
if (params.has('deletion-scheduled')) {
  showStatus('Your account will be deleted in 7 days. Changed your mind? Sign in before then to cancel.', 'success');
}
if (params.has('registered') || params.has('signed-out') || params.has('deletion-scheduled')) {
  history.replaceState(null, '', '/signin');
}

// Show / hide password
document.querySelectorAll('[data-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.toggle);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.textContent = showing ? 'Show' : 'Hide';
    button.setAttribute('aria-pressed', String(!showing));
  });
});

// --- Password sign-in --------------------------------------------------------

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;

  if (!email || !password) {
    showStatus('Enter your email and password.', 'error');
    form.elements[email ? 'password' : 'email'].focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Signing in…';
  showStatus('', '');

  try {
    const { ok, data } = await postJson('/api/login', { email, password });
    if (ok) {
      location.assign('/account');
      return;
    }
    if (data.error === 'unconfirmed') {
      showStatus(data.message, 'error');
      resendEmail.value = email;
    } else {
      showStatus(data.error ?? 'Something went wrong. Please try again.', 'error');
    }
    form.elements.password.value = '';
    form.elements.password.focus();
  } catch {
    showStatus("Couldn't reach the server. Check your connection and try again.", 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});

// --- A new confirmation link ---------------------------------------------------

const resendForm = document.getElementById('resend-form');
const resendEmail = document.getElementById('resend-email');
const resendStatus = document.getElementById('resend-status');

resendForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = resendEmail.value.trim();
  if (!email || !resendEmail.checkValidity()) {
    resendStatus.textContent = 'Enter a valid email address.';
    resendStatus.className = 'status error';
    resendEmail.focus();
    return;
  }
  const button = resendForm.querySelector('button');
  button.disabled = true;
  try {
    const { ok, data } = await postJson('/api/resend-verification', { email });
    resendStatus.textContent = data.message ?? data.error ?? 'Something went wrong. Please try again.';
    resendStatus.className = `status ${ok ? 'success' : 'error'}`;
  } catch {
    resendStatus.textContent = "Couldn't reach the server. Check your connection and try again.";
    resendStatus.className = 'status error';
  } finally {
    button.disabled = false;
  }
});

// --- Passkey sign-in ---------------------------------------------------------

// Asks the server for a challenge, lets the device sign it, and sends it back.
// With autofill, the browser waits quietly and offers passkeys in the email field.
async function signInWithPasskey({ autofill = false } = {}) {
  const { ok, data: optionsJSON } = await postJson('/api/passkeys/login/options');
  if (!ok) throw new ServerError(optionsJSON.error ?? 'Something went wrong. Please try again.');

  const response = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });

  const result = await postJson('/api/passkeys/login/verify', { response });
  if (!result.ok) {
    throw new ServerError(result.data.message ?? result.data.error ?? "That passkey couldn't be used to sign in.");
  }
  location.assign('/account');
}

// Our own messages come from the server and are written for people.
// The browser's own errors are technical, so they get a plain message instead.
class ServerError extends Error {}

function passkeyError(err) {
  // The user closed the passkey prompt, or another prompt replaced this one: not an error.
  if (err?.name === 'NotAllowedError' || err?.name === 'AbortError' || err?.code === 'ERROR_CEREMONY_ABORTED') return;
  if (err instanceof ServerError) {
    showStatus(err.message, 'error');
  } else if (err?.name === 'NotSupportedError' || err?.name === 'SecurityError') {
    showStatus("This browser or device can't use passkeys here. Sign in with your password instead.", 'error');
  } else {
    showStatus("That passkey couldn't be used to sign in. Please try again.", 'error');
  }
}

if (browserSupportsWebAuthn()) {
  document.getElementById('passkey-option').hidden = false;

  passkeyButton.addEventListener('click', async () => {
    passkeyButton.disabled = true;
    showStatus('', '');
    try {
      await signInWithPasskey();
    } catch (err) {
      passkeyError(err);
    } finally {
      passkeyButton.disabled = false;
    }
  });

  // Autofill runs quietly in the background. If it can't work on this device,
  // say nothing: the password form and the passkey button are still there.
  if (await browserSupportsWebAuthnAutofill()) {
    signInWithPasskey({ autofill: true }).catch((err) => {
      if (err instanceof ServerError) passkeyError(err);
    });
  }
}
