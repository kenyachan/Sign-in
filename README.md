# Login screen

A secure sign-in app built with Node.js, Express and SQLite. It will support passwords and passkeys, with account recovery by email link.

## Run it

You need Node.js 22.9 or newer (`node -v` to check; install from nodejs.org).

```bash
npm install        # first time only
npm run db:init    # creates data/app.db and the tables
npm run dev        # starts the server and restarts it when you save a file
```

Open http://localhost:3000. http://localhost:3000/health should show `{"ok":true,"users":0}`.

To change settings, copy `.env.example` to `.env` and edit it.

## Email

The app sends two emails: a link to confirm your address after sign-up, and a heads-up to the owner if someone tries to sign up with an email that's already registered.

**On your computer**, use [Mailpit](https://mailpit.axllent.org). It catches every email the app sends, so nothing reaches a real inbox:

```bash
brew install mailpit
mailpit
```

Leave it running, then open http://localhost:8025 to read the emails. If Mailpit isn't running, sign-up still works; the terminal just logs that the email couldn't be sent.

**With Resend** (set up 2026-11-19), emails really go out from `no-reply@mail.kenyachan.dev`:

- Domain **`mail.kenyachan.dev`** in Resend's Tokyo region (`ap-northeast-1`), with open and click tracking **off** (tracking would rewrite the one-time links) and TLS enforced. Resend recommends a subdomain so this email can't affect any other email you send from `kenyachan.dev`.
- DNS records in Squarespace (Domains → kenyachan.dev → DNS → Custom records): a DKIM TXT record on `resend._domainkey.mail`; an MX (priority 10) and an SPF TXT record on `send.mail`; a CNAME on `rsend.mail`; and a DMARC TXT record on `_dmarc.mail` with `v=DMARC1; p=none;`.
- A **sending-only** API key, restricted to `mail.kenyachan.dev`, saved in `.env` as:
   ```
   EMAIL_FROM=Kenya Chan <no-reply@mail.kenyachan.dev>
   SMTP_URL=smtps://resend:re_YOUR_API_KEY@smtp.resend.com:465
   ```
- To go back to Mailpit on your computer, comment out `SMTP_URL` in `.env`. In production, put the same two settings in your host's environment variables rather than copying `.env` to the server.

The app uses plain SMTP, so Postmark, Amazon SES or Mailgun work too: only `SMTP_URL` changes.

## Passkeys

Signed-in users can add passkeys on the account page, then sign in with Face ID, Touch ID, a fingerprint or a device PIN: either with the **Sign in with a passkey** button, or by picking a passkey straight from the username field (browser autofill). Passwords keep working alongside them.

- **On your computer**, open the site at exactly **http://localhost:3000** (not 127.0.0.1): a passkey belongs to one domain.
- **In production**, passkeys belong to the domain in `APP_ORIGIN` (e.g. `kenyachan.dev`). Passkeys made on localhost won't work there, and vice versa.
- The server stores only each passkey's **public key**, so a stolen database can't be used to sign in, and a look-alike website can't use your passkeys.
- A password lockout doesn't block passkey sign-in, so the real owner always has a way in.

## Account recovery

If someone forgets their password or loses their passkey, **Forgot your password or lost your passkey?** on the sign-in page asks for their email and sends a link.

- Links go only to **confirmed** email addresses. The reply is the same whether or not an account exists, so the page can't be used to find out who has an account.
- A link works **once** and expires after **15 minutes**. Asking again cancels the earlier link.
- The link offers two ways back in: **set a new password**, or **sign in and add a new passkey**.
- Either way, **every other device is signed out**, any password lockout is cleared, and the owner gets an email saying it happened.
- Limits: 3 links an hour per email address, 5 requests an hour per network.

Because a recovery link gives full access, an account is only as safe as its email inbox.

## Deleting an account

The account page has a **Delete account** button at the bottom. It opens a warning that deletion is permanent and that the account and its information can't be recovered afterwards.

- To confirm, the user **types their username** and enters their **password**. Accounts without a password confirm with one of their **passkeys** instead. Being signed in isn't enough, so someone using a computer that was left signed in can't delete the account.
- Wrong passwords count towards the same **lockout** as the sign-in form.
- The account is then **scheduled** for deletion **7 days** later (`deletionGraceDays` in `src/config.js`). Every device is signed out and the owner gets an email.
- During those 7 days the owner can **sign in and cancel** from the account page, and gets an email when they do. Recovery links still work, so the real owner can take back an account that someone else asked to delete.
- After 7 days the server **erases** the user (the hourly clean-up in `src/server.js`, so it happens within an hour of the deadline). Their sessions, passkeys and email links are removed with it, along with any failed sign-in counts. A final email confirms it. There's no undo, and the username and email can be used again.
- Older databases are upgraded automatically on start: `users` gains a `delete_after` column.

## Tests

```bash
npm test
```

Runs 136 checks in about 10 seconds, using Node's built-in test runner. Each test file starts its own copy of the app with an empty in-memory database, so your real `data/app.db` is never touched.

| File | What it checks |
|---|---|
| `tests/validation.test.js` | Sign-up rules for usernames, emails and passwords |
| `tests/register.test.js` | Sign-up: hashing, duplicate usernames and emails, bad input |
| `tests/signin.test.js` | Sign-in, sign-out, session cookies, expiry, the account page |
| `tests/lockout.test.js` | Locking a username after 5 wrong passwords |
| `tests/rate-limit.test.js` | Per-network limits on sign-in, sign-up and the API |
| `tests/email.test.js` | Confirmation emails: one-time links, expiry, resending, safe link addresses |
| `tests/passkeys.test.js` | Adding, naming, using and removing passkeys; replays, phishing, forged signatures, copied passkeys |
| `tests/authenticator.js` | A software passkey (real P-256 keys) that stands in for Face ID / Touch ID in the tests |
| `tests/recovery.test.js` | Recovery links: who gets one, expiry, one use, new password, sign out everywhere, notices |
| `tests/account-delete.test.js` | Deleting an account: confirming it's you, the 7-day wait, cancelling, erasing everything |
| `tests/csrf.test.js` | Requests from other websites are blocked |
| `tests/headers.test.js` | Security headers and no inline scripts or styles |
| `tests/production.test.js` | HTTPS redirect, HSTS and `__Host-` cookies in production mode |
| `tests/helpers.js` | Starts the app for a test and acts as a browser that keeps cookies |

Run one file with `node --test tests/lockout.test.js`. Run the tests after every change: if one fails, the message says which check broke.

## HTTPS

**On your computer** plain `http://localhost` is fine: browsers treat localhost as secure, and passkeys work there too.
To try real HTTPS locally, install [mkcert](https://github.com/FiloSottile/mkcert), then:

```bash
mkdir certs && mkcert -install
mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost.pem localhost
```

and add `HTTPS_KEY_FILE=./certs/localhost-key.pem` and `HTTPS_CERT_FILE=./certs/localhost.pem` to `.env`.

**In production** let your host or a reverse proxy (Caddy gets certificates automatically) handle HTTPS, and set
`NODE_ENV=production`, `APP_ORIGIN=https://your-domain` and `TRUST_PROXY=1`. That turns on:
the redirect from http to https, HSTS, `Secure` + `__Host-` session cookies, and `upgrade-insecure-requests`.

## Layout

| Path | What it is |
|---|---|
| `src/app.js` | The Express app: middleware and routes |
| `src/server.js` | Starts the app (HTTP, or HTTPS with certificate files) |
| `src/db.js` | Opens the database and creates the tables |
| `src/schema.sql` | The tables: users, sessions, passkeys, email_tokens |
| `src/init-db.js` | `npm run db:init`: creates the tables and lists them |
| `src/routes/register.js` | `POST /api/register`: checks the fields, hashes the password with Argon2id, saves the user |
| `src/routes/auth.js` | `POST /api/login`, `POST /api/logout`, `GET /api/me` |
| `src/sessions.js` | Session cookies: start, check on every request, end, clean up |
| `src/lockout.js` | Locks a username after 5 wrong passwords (15 min, doubling up to 24 h) |
| `src/rate-limits.js` | Per-IP limits on sign-in, sign-up and the whole API |
| `src/csrf.js` | Blocks requests sent from other websites; API accepts JSON only |
| `src/config.js` | Settings read from `.env` |
| `src/mailer.js` | Sends email over SMTP (Mailpit locally, your email service in production) |
| `src/emails.js` | The text of each email |
| `src/email-tokens.js` | One-time email links: create, check, use once |
| `src/routes/email.js` | `POST /api/verify-email`, `POST /api/resend-verification` |
| `src/routes/passkeys.js` | Passkey routes: add, list, remove, sign in |
| `src/passkeys.js` | Passkey and challenge storage |
| `src/routes/recovery.js` | `/api/recovery/*`: request a link, check it, set a new password, sign in |
| `src/routes/account.js` | `POST /api/account/deletion` (ask to delete, after confirming it's you), `DELETE` (cancel), `POST /api/account/confirm-options` (passkey check) |
| `src/account-deletion.js` | Scheduling, cancelling and erasing accounts after the 7-day wait |
| `src/validation.js` | The sign-up rules (username, email, password) |
| `public/signup.html` | The sign-up page, at http://localhost:3000/signup |
| `public/signup.js` | Checks the form in the browser and sends it to the server |
| `public/signin.html`, `signin.js` | The sign-in page, at /signin |
| `public/verify-email.html`, `verify-email.js` | Opened from the confirmation email |
| `public/recover.html`, `recover.js` | "Lost access?": asks for the email, at /recover |
| `public/recover-continue.html`, `recover-continue.js` | Opened from the recovery email |
| `views/account.html`, `public/account.js` | The account page, at /account (signed-in only) |
| `public/styles.css` | Shared styles; light or dark follows your system setting |
| `public/` | Pages and files anyone can load |
| `views/` | Pages that need you to be signed in (served only through a route that checks) |
| `data/` | The SQLite database file (not committed to git) |

## Build order

1. ~~Database tables~~ ✓
2. ~~Sign-up~~ ✓
3. ~~Sign-in and sign-out~~ ✓
4. Account page and session check
5. ~~Rate limiting, CSRF protection, HTTPS~~ ✓
6. ~~Test the failure cases~~ ✓ (`npm test`)
7. ~~Email sending (Mailpit locally) and email verification~~ ✓
8. ~~Passkeys~~ ✓
9. ~~Email recovery links~~ ✓
