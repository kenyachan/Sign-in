// The emails the app sends. Each has a plain-text version and a simple HTML version.
import { deletionGraceDays, linkBase } from './config.js';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function html(paragraphs, button) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('');
  const link = button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:12px 20px;background:#18181b;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#71717a">Or copy this link into your browser:<br>${escapeHtml(button.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:32px;background:#fafafa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#18181b;line-height:1.5">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px">${body}${link}</div>
</body></html>`;
}

export function verificationEmail(username, token) {
  // The token goes after "#", so it never reaches server logs or other sites.
  const url = `${linkBase}/verify-email#token=${token}`;
  const lines = [
    `Hi ${username},`,
    'Please confirm this is your email address. The link works once and expires in 24 hours.',
  ];
  const ignore = "If you didn't create an account, you can ignore this email.";
  return {
    subject: 'Confirm your email address',
    text: `${lines.join('\n\n')}\n\n${url}\n\n${ignore}\n`,
    html: html([...lines, ignore], { label: 'Confirm email address', url }),
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

export function recoveryEmail(username, token) {
  const url = `${linkBase}/recover-continue#token=${token}`;
  const lines = [
    `Hi ${username},`,
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

export function accountRecoveredEmail(username, how) {
  const what = how === 'password'
    ? 'Your password was just changed using an account recovery link.'
    : 'Someone just signed in to your account using an account recovery link.';
  const lines = [
    `Hi ${username},`,
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

export function deletionScheduledEmail(username, deleteAfter) {
  const signIn = `${linkBase}/signin`;
  const lines = [
    `Hi ${username},`,
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

export function deletionCancelledEmail(username) {
  const recover = `${linkBase}/recover`;
  const lines = [
    `Hi ${username},`,
    'The request to delete your account has been cancelled. Your account and its information are being kept.',
    "If you didn't cancel it, someone else may be signed in to your account. Use a recovery link to take it back and sign everyone else out.",
  ];
  return {
    subject: 'Your account will not be deleted',
    text: `${lines.join('\n\n')}\n\n${recover}\n`,
    html: html(lines, { label: 'Request a recovery link', url: recover }),
  };
}

export function accountDeletedEmail(username) {
  const lines = [
    `Hi ${username},`,
    'Your account and all of its information have now been permanently deleted, as requested.',
    "This can't be undone. You're welcome to create a new account at any time.",
  ];
  return {
    subject: 'Your account has been deleted',
    text: `${lines.join('\n\n')}\n`,
    html: html(lines),
  };
}
