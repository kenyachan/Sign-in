// Checks the form in the browser for quick feedback, then sends it to the server.
// The server repeats every check, so nothing here is relied on for security.

const form = document.getElementById('signup-form');
const submit = form.querySelector('button[type="submit"]');
const status = document.getElementById('status');
const fields = ['firstName', 'lastName', 'email', 'password', 'confirm'];

function setError(name, message) {
  const input = form.elements[name];
  document.getElementById(`${name}-error`).textContent = message ?? '';
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function clearErrors() {
  fields.forEach((name) => setError(name, ''));
  status.textContent = '';
  status.className = 'status';
}

// The same name rules as the server: letters from any language, spaces, hyphens,
// apostrophes and full stops.
const NAME_PATTERN = /^[\p{L}\p{M} '’.-]+$/u;
function nameError(name, required, label) {
  if (name === '') return required ? `Enter your ${label}.` : null;
  if ([...name].length > 50) return 'Use at most 50 characters.';
  if (!NAME_PATTERN.test(name) || !/\p{L}/u.test(name)) return 'Use letters, spaces, hyphens and apostrophes only.';
  return null;
}

function checkInBrowser(values) {
  const errors = {};
  const first = nameError(values.firstName, true, 'first name');
  if (first) errors.firstName = first;
  const last = nameError(values.lastName, false, 'last name');
  if (last) errors.lastName = last;
  if (!form.elements.email.checkValidity() || values.email === '') {
    errors.email = 'Enter a valid email address.';
  }
  if ([...values.password].length < 12) {
    errors.password = 'Use at least 12 characters.';
  }
  if (values.confirm !== values.password) {
    errors.confirm = "The passwords don't match.";
  }
  return errors;
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

// Clear a field's error as soon as the user edits it
fields.forEach((name) => {
  form.elements[name].addEventListener('input', () => setError(name, ''));
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();

  const values = Object.fromEntries(fields.map((name) => [name, form.elements[name].value]));
  values.firstName = values.firstName.replace(/\s+/g, ' ').trim();
  values.lastName = values.lastName.replace(/\s+/g, ' ').trim();
  values.email = values.email.trim();

  const errors = checkInBrowser(values);
  if (Object.keys(errors).length > 0) {
    Object.entries(errors).forEach(([name, message]) => setError(name, message));
    form.elements[Object.keys(errors)[0]].focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Creating account…';

  try {
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email,
        password: values.password,
      }),
    });
    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      location.assign('/signin?registered');
      return;
    }

    if (data.errors) {
      Object.entries(data.errors).forEach(([name, message]) => setError(name, message));
      const first = Object.keys(data.errors)[0];
      if (form.elements[first]) form.elements[first].focus();
    } else {
      status.textContent = data.error ?? 'Something went wrong. Please try again.';
      status.className = 'status error';
    }
  } catch {
    status.textContent = "Couldn't reach the server. Check your connection and try again.";
    status.className = 'status error';
  } finally {
    submit.disabled = false;
    submit.textContent = 'Create account';
  }
});
