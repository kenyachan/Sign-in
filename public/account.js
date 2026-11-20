import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '/vendor/simplewebauthn/index.js';

const signOut = document.getElementById('sign-out');
const resend = document.getElementById('resend');
const status = document.getElementById('status');

function showStatus(message, kind) {
  status.textContent = message;
  status.className = `status ${kind}`;
}

async function loadAccount() {
  const response = await fetch('/api/me');
  if (response.status === 401) {
    location.replace('/signin');
    return;
  }
  const me = await response.json();
  document.getElementById('username').textContent = me.username;
  document.getElementById('email').textContent = me.email;

  const badge = document.getElementById('email-status');
  badge.textContent = me.emailVerified ? 'Confirmed' : 'Not confirmed';
  badge.className = `badge ${me.emailVerified ? 'badge-ok' : 'badge-warn'}`;
  document.getElementById('verify-notice').hidden = me.emailVerified;

  account = me;
  showDeletionState();
}

resend.addEventListener('click', async () => {
  resend.disabled = true;
  try {
    const response = await fetch('/api/resend-verification', { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    showStatus(data.message ?? data.error ?? 'Something went wrong.', response.ok ? 'success' : 'error');
  } catch {
    showStatus("Couldn't reach the server. Please try again.", 'error');
  } finally {
    resend.disabled = false;
  }
});

signOut.addEventListener('click', async () => {
  signOut.disabled = true;
  signOut.textContent = 'Signing out…';
  try {
    await fetch('/api/logout', { method: 'POST' });
    location.replace('/signin?signed-out');
  } catch {
    showStatus("Couldn't reach the server. Please try again.", 'error');
    signOut.disabled = false;
    signOut.textContent = 'Sign out';
  }
});

// --- Passkeys -------------------------------------------------------------

const passkeyList = document.getElementById('passkey-list');
const addPasskey = document.getElementById('add-passkey');
const passkeyStatus = document.getElementById('passkey-status');

function showPasskeyStatus(message, kind) {
  passkeyStatus.textContent = message;
  passkeyStatus.className = `status ${kind}`;
}

const formatDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const NICKNAME_MAX = 50;

// One row in the list: the name and dates, with Rename and Remove buttons.
function passkeyRow(passkey) {
  const item = document.createElement('li');
  item.className = 'passkey';
  item.dataset.id = passkey.id;

  const text = document.createElement('div');
  text.className = 'passkey-text';
  const name = document.createElement('p');
  name.className = 'passkey-name';
  name.textContent = passkey.nickname;       // textContent: never treated as HTML
  const meta = document.createElement('p');
  meta.className = 'passkey-meta';
  meta.textContent = [
    `Added ${formatDate(passkey.createdAt)}`,
    passkey.lastUsedAt ? `last used ${formatDate(passkey.lastUsedAt)}` : 'not used yet',
    passkey.synced ? 'synced' : null,
  ].filter(Boolean).join(' · ');
  text.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'passkey-actions';

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'link-button';
  rename.textContent = 'Rename';
  rename.addEventListener('click', () => startRename(item, passkey));

  // Two clicks to remove, so it can't happen by accident.
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link-button danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    if (remove.dataset.confirm !== 'yes') {
      remove.dataset.confirm = 'yes';
      remove.textContent = 'Confirm remove';
      return;
    }
    remove.disabled = true;
    const response = await fetch(`/api/passkeys/${passkey.id}`, { method: 'DELETE' });
    if (response.ok) {
      showPasskeyStatus(`Removed "${passkey.nickname}".`, 'success');
      loadPasskeys();
    } else {
      const data = await response.json().catch(() => ({}));
      showPasskeyStatus(data.error ?? "Couldn't remove that passkey.", 'error');
      remove.disabled = false;
    }
  });

  actions.append(rename, remove);
  item.append(text, actions);
  return item;
}

// Swaps a row for a small form with the name ready to edit.
function startRename(item, passkey, { justAdded = false } = {}) {
  const form = document.createElement('form');
  form.className = 'rename-form';
  form.noValidate = true;

  const label = document.createElement('label');
  label.htmlFor = `passkey-name-${passkey.id}`;
  label.textContent = justAdded ? 'Name your new passkey' : 'Passkey name';

  const input = document.createElement('input');
  input.id = `passkey-name-${passkey.id}`;
  input.type = 'text';
  input.value = passkey.nickname;
  input.maxLength = NICKNAME_MAX;
  input.autocomplete = 'off';
  input.placeholder = 'e.g. 1Password, MacBook, iPhone';

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'So you can tell your passkeys apart, e.g. where it is saved.';

  const error = document.createElement('p');
  error.className = 'error';

  const buttons = document.createElement('div');
  buttons.className = 'rename-buttons';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary small';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'link-button';
  cancel.textContent = justAdded ? 'Keep this name' : 'Cancel';
  buttons.append(save, cancel);

  form.append(label, input, hint, error, buttons);
  item.replaceChildren(form);
  input.focus();
  input.select();

  const close = () => item.replaceWith(passkeyRow(passkey));
  cancel.addEventListener('click', close);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  input.addEventListener('input', () => { error.textContent = ''; });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const nickname = input.value.trim();
    if (!nickname) {
      error.textContent = 'Enter a name.';
      input.focus();
      return;
    }
    if (nickname === passkey.nickname) {
      close();
      return;
    }
    save.disabled = true;
    try {
      const response = await fetch(`/api/passkeys/${passkey.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        error.textContent = data.error ?? "Couldn't rename this passkey.";
        save.disabled = false;
        return;
      }
      Object.assign(passkey, data);
      close();
      showPasskeyStatus(`Saved "${data.nickname}".`, 'success');
    } catch {
      error.textContent = "Couldn't reach the server. Please try again.";
      save.disabled = false;
    }
  });
}

function renderPasskeys(passkeys, { nameNew } = {}) {
  passkeyList.replaceChildren();
  if (passkeys.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'passkey-empty';
    empty.textContent = 'No passkeys yet.';
    passkeyList.append(empty);
    return;
  }
  for (const passkey of passkeys) {
    const row = passkeyRow(passkey);
    passkeyList.append(row);
    if (passkey.id === nameNew) startRename(row, passkey, { justAdded: true });
  }
}

async function loadPasskeys(options) {
  const response = await fetch('/api/passkeys');
  if (response.ok) renderPasskeys(await response.json(), options);
}

addPasskey.addEventListener('click', async () => {
  addPasskey.disabled = true;
  showPasskeyStatus('', '');
  try {
    const optionsResponse = await fetch('/api/passkeys/register/options', { method: 'POST' });
    const optionsJSON = await optionsResponse.json();
    if (!optionsResponse.ok) throw Object.assign(new Error(optionsJSON.error), { fromServer: true });

    const response = await startRegistration({ optionsJSON });

    const verify = await fetch('/api/passkeys/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response }),
    });
    const data = await verify.json().catch(() => ({}));
    if (!verify.ok) throw Object.assign(new Error(data.error), { fromServer: true });

    // Straight away, offer to name it (the browser doesn't tell us where it was saved).
    showPasskeyStatus('Passkey added. You can now sign in with it.', 'success');
    loadPasskeys({ nameNew: data.id });
  } catch (err) {
    if (err?.name === 'NotAllowedError') {
      showPasskeyStatus('Cancelled. No passkey was added.', '');
    } else if (err?.name === 'InvalidStateError') {
      showPasskeyStatus('This device already has a passkey for your account.', 'error');
    } else if (err?.fromServer && err.message) {
      showPasskeyStatus(err.message, 'error');
    } else if (err?.name === 'NotSupportedError' || err?.name === 'SecurityError') {
      showPasskeyStatus("This browser or device can't create passkeys here.", 'error');
    } else {
      showPasskeyStatus("Couldn't add a passkey. Please try again.", 'error');
    }
  } finally {
    addPasskey.disabled = false;
  }
});

if (!browserSupportsWebAuthn()) {
  addPasskey.hidden = true;
  document.getElementById('passkey-unsupported').hidden = false;
}

// Arriving from an account-recovery link.
const recovered = new URLSearchParams(location.search).get('recovered');
if (recovered) {
  history.replaceState(null, '', '/account');
  if (recovered === 'password') {
    showStatus("Your password has been changed, and every other device has been signed out.", 'success');
  } else {
    showPasskeyStatus("You're signed in, and every other device has been signed out. Add a new passkey now so you can sign in next time.", 'success');
    addPasskey.focus();
  }
}

// --- Deleting the account ---------------------------------------------------
// Asking to delete opens a warning with a confirmation step. The account is then
// erased 7 days later; until then, the owner can sign in and cancel.

let account = null;   // what /api/me said about the signed-in user

const deleteSection = document.getElementById('delete-section');
const deleteButton = document.getElementById('delete-account');
const deleteDialog = document.getElementById('delete-dialog');
const deleteForm = document.getElementById('delete-form');
const deleteUsername = document.getElementById('delete-username');
const deletePassword = document.getElementById('delete-password');
const deleteError = document.getElementById('delete-error');
const deleteConfirm = document.getElementById('delete-confirm');
const deletionNotice = document.getElementById('deletion-notice');
const cancelDeletion = document.getElementById('cancel-deletion');

const formatDateTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });

// Scheduled for deletion: show when, with a way to cancel, instead of the delete button.
function showDeletionState() {
  const scheduled = Boolean(account.deleteAfter);
  deletionNotice.hidden = !scheduled;
  deleteSection.hidden = scheduled;
  if (scheduled) document.getElementById('deletion-date').textContent = formatDateTime(account.deleteAfter);
}

const usernameMatches = () => deleteUsername.value.trim().toLowerCase() === account.username.toLowerCase();

// The final button only works once the username matches (and the password is filled in).
function updateDeleteConfirm() {
  deleteConfirm.disabled = !usernameMatches() || (account.hasPassword && !deletePassword.value);
}

deleteButton.addEventListener('click', () => {
  if (!account) return;
  deleteForm.reset();
  deleteError.textContent = '';
  document.getElementById('delete-username-hint').textContent = account.username;
  document.getElementById('delete-password-field').hidden = !account.hasPassword;
  document.getElementById('delete-passkey-hint').hidden = account.hasPassword;
  updateDeleteConfirm();
  deleteDialog.showModal();   // Escape closes it, like Cancel
  deleteUsername.focus();
});

deleteUsername.addEventListener('input', () => { deleteError.textContent = ''; updateDeleteConfirm(); });
deletePassword.addEventListener('input', () => { deleteError.textContent = ''; updateDeleteConfirm(); });
document.getElementById('delete-cancel').addEventListener('click', () => deleteDialog.close());
deleteDialog.addEventListener('close', () => {
  deletePassword.value = '';   // never leave a password sitting in the page
  deleteButton.focus();
});

const serverError = (message) => Object.assign(new Error(message), { fromServer: true });

// Asks the device to sign a challenge with one of this account's passkeys.
async function confirmWithPasskey() {
  if (!browserSupportsWebAuthn()) {
    throw serverError("This browser can't use passkeys. Try again on a device with one of your passkeys.");
  }
  const response = await fetch('/api/account/confirm-options', { method: 'POST' });
  const optionsJSON = await response.json().catch(() => ({}));
  if (!response.ok) throw serverError(optionsJSON.error ?? 'Something went wrong. Please try again.');
  return startAuthentication({ optionsJSON });
}

deleteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (deleteConfirm.disabled) return;
  if (!usernameMatches()) {
    deleteError.textContent = "That isn't your username.";
    deleteUsername.focus();
    return;
  }

  deleteConfirm.disabled = true;
  deleteConfirm.textContent = 'Deleting…';
  deleteError.textContent = '';
  try {
    const body = { username: deleteUsername.value.trim() };
    if (account.hasPassword) body.password = deletePassword.value;
    else body.passkey = await confirmWithPasskey();

    const response = await fetch('/api/account/deletion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      location.replace('/signin?deletion-scheduled');   // this browser has been signed out
      return;
    }
    deleteError.textContent = data.error ?? "Couldn't delete your account. Please try again.";
    if (account.hasPassword) {
      deletePassword.value = '';
      deletePassword.focus();
    }
  } catch (err) {
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
      deleteError.textContent = 'Cancelled. Your account has not been deleted.';
    } else if (err?.fromServer) {
      deleteError.textContent = err.message;
    } else if (err instanceof TypeError) {
      deleteError.textContent = "Couldn't reach the server. Please try again.";
    } else {
      deleteError.textContent = "That passkey couldn't confirm it's you. Please try again.";
    }
  } finally {
    deleteConfirm.textContent = 'Delete my account';
    updateDeleteConfirm();
  }
});

cancelDeletion.addEventListener('click', async () => {
  cancelDeletion.disabled = true;
  try {
    const response = await fetch('/api/account/deletion', { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      account.deleteAfter = null;
      showDeletionState();
    }
    showStatus(data.message ?? data.error ?? 'Something went wrong.', response.ok ? 'success' : 'error');
  } catch {
    showStatus("Couldn't reach the server. Please try again.", 'error');
  } finally {
    cancelDeletion.disabled = false;
  }
});

loadAccount();
loadPasskeys();
