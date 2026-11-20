// Shared test tools: start a copy of the app with its own empty in-memory
// database, and a tiny "browser" that remembers cookies between requests.
import { once } from 'node:events';

export const PASSWORD = 'correct horse battery';

// Settings must be in place before the app's files are loaded, so they're
// imported here (not at the top of the test file).
export async function startApp(env = {}) {
  Object.assign(process.env, { DATABASE_PATH: ':memory:', EMAIL_TRANSPORT: 'test' }, env);
  const { createApp } = await import('../src/app.js');
  const { db } = await import('../src/db.js');
  const limits = await import('../src/rate-limits.js');
  const { sentEmails } = await import('../src/mailer.js');
  const { resendStore } = await import('../src/routes/email.js');
  const recovery = await import('../src/routes/recovery.js');

  const server = createApp().listen(0, '127.0.0.1');   // port 0 = any free port
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    db,
    sentEmails,   // every email the app "sent", newest last
    newClient: (defaultHeaders) => new Client(base, defaultHeaders),
    // Forget everything the rate limiters have counted, so tests don't affect each other.
    resetRateLimits() {
      for (const limiter of [limits.loginLimiter, limits.registerLimiter, limits.apiLimiter, recovery.recoveryNetworkLimiter]) {
        limiter.resetKey('127.0.0.1');
      }
      resendStore.resetAll();
      recovery.recoveryEmailStore.resetAll();
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

export class Client {
  constructor(base, defaultHeaders = {}) {
    this.base = base;
    this.defaultHeaders = defaultHeaders;
    this.cookies = new Map();
  }

  async request(method, path, { json, body, headers = {} } = {}) {
    const sendHeaders = { ...this.defaultHeaders, ...headers };
    if (this.cookies.size > 0) {
      sendHeaders.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    if (json !== undefined) {
      sendHeaders['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }

    const res = await fetch(this.base + path, { method, headers: sendHeaders, body, redirect: 'manual' });
    this.#storeCookies(res.headers.getSetCookie());

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, headers: res.headers, data, setCookies: res.headers.getSetCookie() };
  }

  get(path, options) { return this.request('GET', path, options); }
  post(path, json, options = {}) { return this.request('POST', path, { ...options, json }); }

  #storeCookies(setCookies) {
    for (const line of setCookies) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = !value || attributes.some((a) => {
        const [key, val] = a.split('=').map((s) => s?.trim().toLowerCase());
        return (key === 'max-age' && Number(val) <= 0) ||
               (key === 'expires' && Date.parse(a.split('=')[1]) <= Date.now());
      });
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

export function signUp(client, overrides = {}) {
  return client.post('/api/register', {
    username: 'kenya',
    email: 'kenya@example.com',
    password: PASSWORD,
    ...overrides,
  });
}

export function signIn(client, username = 'kenya', password = PASSWORD) {
  return client.post('/api/login', { username, password });
}
