const form = document.getElementById('recover-form');
const submit = form.querySelector('button[type="submit"]');
const status = document.getElementById('status');

function showStatus(message, kind) {
  status.textContent = message;
  status.className = `status ${kind}`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = form.elements.email.value.trim();
  if (!email || !form.elements.email.checkValidity()) {
    showStatus('Enter a valid email address.', 'error');
    form.elements.email.focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Sending…';
  try {
    const response = await fetch('/api/recovery/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      showStatus(`${data.message} Check your inbox (and spam folder).`, 'success');
    } else {
      showStatus(data.error ?? 'Something went wrong. Please try again.', 'error');
    }
  } catch {
    showStatus("Couldn't reach the server. Check your connection and try again.", 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Send me a link';
  }
});
