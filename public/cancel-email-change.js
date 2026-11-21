// The email link looks like /cancel-email-change#token=...
// The token stays in the browser (after "#") and is only sent when the button is
// pressed, so link scanners in email apps can't use it up.
const message = document.getElementById('message');
const cancel = document.getElementById('cancel');
const next = document.getElementById('next');

const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', '/cancel-email-change');   // remove the token from the address bar

function finish(text, ok) {
  message.textContent = text;
  message.className = `subtitle ${ok ? 'success-text' : 'error-text'}`;
  cancel.hidden = true;
  next.hidden = false;
}

if (!token) finish('This link is incomplete. Try copying the whole link from the email.', false);

cancel.addEventListener('click', async () => {
  cancel.disabled = true;
  try {
    const response = await fetch('/api/account/email/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await response.json().catch(() => ({}));
    finish(response.ok ? data.message : (data.error ?? 'Something went wrong.'), response.ok);
  } catch {
    message.textContent = "Couldn't reach the server. Check your connection and try again.";
    message.className = 'subtitle error-text';
    cancel.disabled = false;
  }
});
