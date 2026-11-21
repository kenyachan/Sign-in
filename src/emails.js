// The emails the app sends. Each has a plain-text version and a simple HTML version.
import { deletionGraceDays, linkBase, unconfirmedAccountDays } from './config.js';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// "Hi Kenya," — or "Hi there," if we don't have a first name.
const greeting = (firstName) => `Hi ${firstName || 'there'},`;

// `after` is an optional small print paragraph with its own link, e.g. "This wasn't me".
function html(paragraphs, button, after) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('');
  const smallPrint = after
    ? `<p style="margin:24px 0 0;font-size:13px;color:#71717a">${escapeHtml(after.text)} <a href="${escapeHtml(after.url)}" style="color:#71717a">${escapeHtml(after.label)}</a></p>`
    : '';
  const link = button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:12px 20px;background:#18181b;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#71717a">Or copy this link into your browser:<br>${escapeHtml(button.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:32px;background:#fafafa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#18181b;line-height:1.5">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px">${body}${link}${smallPrint}</div>
</body></html>`;
}

// Links go after "#", so tokens never reach server logs or other sites.
const confirmUrl = (token) => `${linkBase}/verify-email#token=${token}`;
const cancelSignupUrl = (token) => `${linkBase}/cancel-signup#token=${token}`;

export function verificationEmail(firstName, token, cancelToken) {
  const url = confirmUrl(token);
  const lines = [
    greeting(firstName),
    'Please confirm this is your email address. The link works once and expires in 24 hours.',
    `You can sign in once your address is confirmed. If it isn't confirmed within ${unconfirmedAccountDays} days, the account is deleted.`,
  ];
  const notMe = "Didn't create an account? Cancel this sign-up and the account will be deleted:";
  return {
    subject: 'Confirm your email address',
    text: `${lines.join('\n\n')}\n\n${url}\n\n${notMe}\n${cancelSignupUrl(cancelToken)}\n`,
    html: html(lines, { label: 'Confirm email address', url },
      { text: "Didn't create an account?", label: 'Cancel this sign-up', url: cancelSignupUrl(cancelToken) }),
  };
}

// Someone signed up with an address that already has a sign-up waiting for
// confirmation. No name in the greeting: it was typed by whoever signed up first.
export function pendingSignupEmail(token, cancelToken) {
  const url = confirmUrl(token);
  const lines = [
    'Hi there,',
    'Someone just tried to create an account with this email address, but there is already a sign-up waiting for it to be confirmed.',
    'If that first sign-up was yours, confirm it with the button below (the link expires in 24 hours).',
    "If it wasn't yours, cancel it. That deletes the waiting account, and you can then sign up yourself.",
  ];
  return {
    subject: 'Confirm or cancel the sign-up for this email',
    text: `${lines.join('\n\n')}\n\nConfirm: ${url}\n\nCancel: ${cancelSignupUrl(cancelToken)}\n`,
    html: html(lines, { label: 'Confirm email address', url },
      { text: "Wasn't you?", label: 'Cancel this sign-up', url: cancelSignupUrl(cancelToken) }),
  };
}

export function alreadyRegisteredEmail() {
  const signIn = `${linkBase}/signin`;
  const lines = [
    'Someone just tried to create a new account with this email address.',
    'It already belongs to your account, so nothing has changed.',
    "If it was you, sign in instead. If it wasn't, you don't need to do anything.",
  ];
  return {
    subject: 'Someone tried to sign up with your email',
    text: `${lines.join('\n\n')}\n\n${signIn}\n`,
    html: html(lines, { label: 'Sign in', url: signIn }),
  };
}

export function recoveryEmail(firstName, token) {
  const url = `${linkBase}/recover-continue#token=${token}`;
  const lines = [
    greeting(firstName),
    'Someone (hopefully you) asked for a link to get back into your account. With it you can set a new password, or sign in and add a new passkey.',
    'The link works once and expires in 15 minutes.',
  ];
  const ignore = "If you didn't ask for this, you can ignore this email. Your account hasn't changed.";
  return {
    subject: 'Get back into your account',
    text: `${lines.join('\n\n')}\n\n${url}\n\n${ignore}\n`,
    html: html([...lines, ignore], { label: 'Get back into my account', url }),
  };
}

export function accountRecoveredEmail(firstName, how) {
  const what = how === 'password'
    ? 'Your password was just changed using an account recovery link.'
    : 'Someone just signed in to your account using an account recovery link.';
  const lines = [
    greeting(firstName),
    what,
    'For your safety, every other device has been signed out.',
    "If this was you, there's nothing else to do. If it wasn't, request a new recovery link straight away to take your account back, and change your email password: whoever did this can read your email.",
  ];
  const recover = `${linkBase}/recover`;
  return {
    subject: how === 'password' ? 'Your password was changed' : 'Your account was recovered',
    text: `${lines.join('\n\n')}\n\n${recover}\n`,
    html: html(lines, { label: 'Request a recovery link', url: recover }),
  };
}

// --- Deleting an account ----------------------------------------------------

// The server doesn't know the reader's time zone, so dates in emails are in UTC.
const formatUtc = (iso) => `${new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC',
}).format(new Date(iso))} UTC`;

export function deletionScheduledEmail(firstName, deleteAfter) {
  const signIn = `${linkBase}/signin`;
  const lines = [
    greeting(firstName),
    `Your account is scheduled to be deleted on ${formatUtc(deleteAfter)}. You've been signed out on every device.`,
    'Deletion is permanent. Once it happens, there is no way to recover your account or any of its information.',
    'Changed your mind? Sign in before then and choose "Cancel deletion" on your account page.',
    "If you didn't ask for this, sign in (or use the \"Forgot your password\" link) and cancel it straight away, then change your password.",
  ];
  return {
    subject: `Your account will be deleted in ${deletionGraceDays} days`,
    text: `${lines.join('\n\n')}\n\n${signIn}\n`,
    html: html(lines, { label: 'Sign in to cancel', url: signIn }),
  };
}

export function deletionCancelledEmail(firstName) {
  const recover = `${linkBase}/recover`;
  const lines = [
    greeting(firstName),
    'The request to delete your account has been cancelled. Your account and its information are being kept.',
    "If you didn't cancel it, someone else may be signed in to your account. Use a recovery link to take it back and sign everyone else out.",
  ];
  return {
    subject: 'Your account will not be deleted',
    text: `${lines.join('\n\n')}\n\n${recover}\n`,
    html: html(lines, { label: 'Request a recovery link', url: recover }),
  };
}

export function accountDeletedEmail(firstName) {
  const lines = [
    greeting(firstName),
    'Your account and all of its information have now been permanently deleted, as requested.',
    "This can't be undone. You're welcome to create a new account at any time.",
  ];
  return {
    subject: 'Your account has been deleted',
    text: `${lines.join('\n\n')}\n`,
    html: html(lines),
  };
}

// --- Changing the sign-in email -----------------------------------------------

// Sent to the NEW address: proves the person asking really owns it.
export function confirmNewEmailEmail(firstName, token) {
  const url = `${linkBase}/confirm-email-change#token=${token}`;
  const lines = [
    greeting(firstName),
    'Please confirm you want to use this email address to sign in. The link works once and expires in 24 hours.',
    "Until you confirm, you'll keep signing in with your current address. Once you do, you'll be signed out on every device and can sign in with this one.",
  ];
  const ignore = "If you didn't ask for this, you can ignore this email. Nothing will change.";
  return {
    subject: 'Confirm your new email address',
    text: `${lines.join('\n\n')}\n\n${url}\n\n${ignore}\n`,
    html: html([...lines, ignore], { label: 'Confirm new email address', url }),
  };
}

// Sent to the OLD address straight away, with a way to stop the change.
export function emailChangeRequestedEmail(firstName, maskedNewEmail, cancelToken) {
  const url = `${linkBase}/cancel-email-change#token=${cancelToken}`;
  const lines = [
    greeting(firstName),
    `Someone signed in to your account and asked to change its sign-in email to ${maskedNewEmail}.`,
    "If this was you, there's nothing to do here: confirm the change using the link we sent to the new address.",
    "If it wasn't you, cancel the change now, then change your password: someone may know it.",
  ];
  return {
    subject: 'Your sign-in email is being changed',
    text: `${lines.join('\n\n')}\n\nCancel the change: ${url}\n`,
    html: html(lines, { label: 'Cancel this change', url }),
  };
}

// Sent to the new address when it already belongs to another account. No link:
// nothing should change, and the person who asked isn't told either way.
export function emailInUseEmail() {
  const lines = [
    'Hi there,',
    'Someone just asked to move a different account to this email address.',
    'This address already has its own account, so nothing has changed. You don\'t need to do anything.',
  ];
  return {
    subject: 'Someone tried to use your email address',
    text: `${lines.join('\n\n')}\n`,
    html: html(lines),
  };
}

// After the change: to the old address...
export function emailChangedOldEmail(firstName, maskedNewEmail) {
  const lines = [
    greeting(firstName),
    `Your account's sign-in email has been changed to ${maskedNewEmail}. Emails about your account will go there from now on.`,
    'Every device has been signed out.',
    "If you didn't make this change, reply to this email or contact support straight away: someone else may have taken over your account.",
  ];
  return {
    subject: 'Your sign-in email was changed',
    text: `${lines.join('\n\n')}\n`,
    html: html(lines),
  };
}

// ...and to the new one.
export function emailChangedNewEmail(firstName) {
  const signIn = `${linkBase}/signin`;
  const lines = [
    greeting(firstName),
    "Your new email address is confirmed. From now on, use it to sign in.",
    "You've been signed out on every device, so sign in again with this address.",
  ];
  return {
    subject: 'Your email address has been changed',
    text: `${lines.join('\n\n')}\n\n${signIn}\n`,
    html: html(lines, { label: 'Sign in', url: signIn }),
  };
}
