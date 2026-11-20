// Opened from the recovery email: /recover-continue#token=...
// The token stays in the browser (after "#") and is only sent when you choose
// what to do, so link scanners in email apps can't use it up.

const message = document.getElementById('message');
const choices = document.getElementById('choices');
const newLink = document.getElementById('new-link');
const form = document.getElementById('password-form');
const save = form.querySelector('button[type="submit"]');
const passkeyRoute = document.getElementById('passkey-route');
const status = document.getElementById('status');

const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', '/recover-continue');   // remove the token from the address bar

function linkProblem(text) {
  message.textContent = text;
  message.className = 'subtitle error-text';
  choices.hidden = true;
  newLink.hidden = false;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, data: await response.json().catch(() => ({})) };
}

function setError(name, text) {
  document.getElementById(`${name}-error`).textContent = text ?? '';
  form.elements[name].setAttribute('aria-invalid', text ? 'true' : 'false');
}

async function start() {
  if (!token) {
    linkProblem('This link is incomplete. Try copying the whole link from the email.');
    return;
  }
  try {
    const { data } = await postJson('/api/recovery/check', { token });
    if (!data.valid) {
      linkProblem('This link is invalid, already used, or expired.');
      return;
    }
    message.textContent = `Choose how to get back into ${data.username}'s account.`;
    form.elements.username.value = data.username;
    choices.hidden = false;
    form.elements.password.focus();
  } catch {
    linkProblem("Couldn't reach the server. Check your connection and reload this page.");
  }
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
['password', 'confirm'].forEach((name) => {
  form.elements[name].addEventListener('input', () => setError(name, ''));
});

// Option 1: set a new password
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = form.elements.password.value;
  const confirm = form.elements.confirm.value;
  setError('password', ''); setError('confirm', '');

  if ([...password].length < 12) {
    setError('password', 'Use at least 12 characters.');
    form.elements.password.focus();
    return;
  }
  if (confirm !== password) {
    setError('confirm', "The passwords don't match.");
    form.elements.confirm.focus();
    return;
  }

  save.disabled = true;
  save.textContent = 'Saving…';
  try {
    const { ok, data } = await postJson('/api/recovery/password', { token, password });
    if (ok) {
      location.replace('/account?recovered=password');
      return;
    }
    if (data.errors?.password) {
      setError('password', data.errors.password);
      form.elements.password.focus();
    } else {
      linkProblem(data.error ?? 'Something went wrong.');
    }
  } catch {
    status.textContent = "Couldn't reach the server. Please try again.";
    status.className = 'status error';
  } finally {
    save.disabled = false;
    save.textContent = 'Save new password';
  }
});

// Option 2: sign in, then add a passkey on the account page
passkeyRoute.addEventListener('click', async () => {
  passkeyRoute.disabled = true;
  try {
    const { ok, data } = await postJson('/api/recovery/signin', { token });
    if (ok) {
      location.replace('/account?recovered=signin');
      return;
    }
    linkProblem(data.error ?? 'Something went wrong.');
  } catch {
    status.textContent = "Couldn't reach the server. Please try again.";
    status.className = 'status error';
  } finally {
    passkeyRoute.disabled = false;
  }
});

start();
