// The email link looks like /confirm-email-change#token=...
// Everything after "#" stays in the browser, so the token never shows up in
// server logs. This page reads it and sends it to the server.
const message = document.getElementById('message');
const next = document.getElementById('next');

async function confirmChange() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', '/confirm-email-change');   // remove the token from the address bar

  if (!token) {
    message.textContent = 'This link is incomplete. Try copying the whole link from the email.';
    message.className = 'subtitle error-text';
    next.hidden = false;
    return;
  }

  try {
    const response = await fetch('/api/account/email/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await response.json().catch(() => ({}));
    message.textContent = response.ok
      ? data.message
      : `${data.error ?? 'Something went wrong.'} You can ask for a new link from your account page.`;
    message.className = `subtitle ${response.ok ? 'success-text' : 'error-text'}`;
  } catch {
    message.textContent = "Couldn't reach the server. Check your connection and reload this page.";
    message.className = 'subtitle error-text';
  }
  next.hidden = false;
}

confirmChange();
