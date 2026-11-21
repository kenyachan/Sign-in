# Login screen

A secure sign-in app built with Node.js, Express and SQLite. People sign in with their **email address** and a password or a passkey, with account recovery by email link. There are no usernames: the email is the account.

## Run it

You need Node.js 22.9 or newer (`node -v` to check; install from nodejs.org).

```bash
npm install        # first time only
npm run db:init    # creates data/app.db and the tables
npm run dev        # starts the server and restarts it when you save a file
```

Open http://localhost:3000. http://localhost:3000/health should show `{"ok":true,"users":0}`.

To change settings, copy `.env.example` to `.env` and edit it.

**Changed `src/schema.sql`?** There's no upgrade code for old databases. Stop the server, delete `data/app.db` (and `app.db-wal`, `app.db-shm`), then run `npm run db:init` again.

## Signing up and confirming the email

Sign-up asks for a **first name** (required), a **last name** (optional, for people with one name), an **email** and a **password**. Emails greet people by first name ("Hi Kenya,").

- Names can use letters from any language, spaces, hyphens, apostrophes and full stops (O'Brien, Nguyễn, José María). Digits, symbols and web addresses are refused, so a "name" can't turn our emails into phishing. Names are only ever put in the body of an email, never its headers.
- The account can't be used until the email address is **confirmed** with the link we send (it works once, for 24 hours).
- Signing in before that, with the right password, says "Please confirm your email address first" and sends a fresh link (at most one every 5 minutes). With a wrong password it's the usual "Incorrect email or password", so this reveals nothing.
- **Didn't get the email?** on the sign-in page sends a new link. The reply is the same for every address.
- The confirmation email also has a **Cancel this sign-up** link, so the real owner of an address can delete a sign-up someone else made with it. Signing up again with an address that's waiting for confirmation emails that address both options.
- Accounts still **unconfirmed after 7 days are deleted** by the hourly clean-up (`unconfirmedAccountDays` in `src/config.js`). No email is sent, because the address was never confirmed.

The account page shows the name with an **Edit** button (`PATCH /api/account/name`).

## Changing the sign-in email

**Change email** on the account page asks for the new address and the password (or a passkey, for accounts without a password).

- The new address gets a **confirmation link** (24 hours). Until it's used, nothing changes: the user keeps signing in with the old address, and the account page shows the change as waiting, with **Send the link again** and **Cancel the change**.
- The **old address is told straight away**, with a link to cancel the change (7 days).
- If the new address already has an account, it gets a notice with no link instead. The person asking sees the same reply either way, so this can't be used to find out who has an account.
- Confirming switches the address, counts it as confirmed, and **signs out every device**. Both addresses are emailed.
- Account recovery cancels any pending change, in case whoever got in tried to move the account to their own address.
- Limits: 5 requests an hour per account. Wrong passwords count towards the sign-in lockout.

## Email

The app sends emails to confirm an address after sign-up, for account recovery, when an account is being deleted, and when the sign-in email changes. It also sends a heads-up if someone tries to sign up with (or move another account to) an address that's already registered.

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

Signed-in users can add passkeys on the account page, then sign in with Face ID, Touch ID, a fingerprint or a device PIN: either with the **Sign in with a passkey** button, or by picking a passkey straight from the email field (browser autofill). Passwords keep working alongside them.

- **On your computer**, open the site at exactly **http://localhost:3000** (not 127.0.0.1): a passkey belongs to one domain.
- **In production**, passkeys belong to the domain in `APP_ORIGIN` (e.g. `kenyachan.dev`). Passkeys made on localhost won't work there, and vice versa.
- The server stores only each passkey's **public key**, so a stolen database can't be used to sign in, and a look-alike website can't use your passkeys.
- A password lockout doesn't block passkey sign-in, so the real owner always has a way in.
- The passkey is saved on the device under the account's email and full name. In browsers that support it, the account page tells the device when these change, so its passkey list stays up to date.

## Account recovery

If someone forgets their password or loses their passkey, **Forgot your password or lost your passkey?** on the sign-in page asks for their email and sends a link.

- Links go only to **confirmed** email addresses (an unconfirmed one gets a new confirmation link instead). The reply is the same whether or not an account exists, so the page can't be used to find out who has an account.
- A link works **once** and expires after **15 minutes**. Asking again cancels the earlier link.
- The link offers two ways back in: **set a new password**, or **sign in and add a new passkey**.
- Either way, **every other device is signed out**, any password lockout is cleared, and the owner gets an email saying it happened.
- Limits: 3 links an hour per email address, 5 requests an hour per network.

Because a recovery link gives full access, an account is only as safe as its email inbox.

## Deleting an account

The account page has a **Delete account** button at the bottom. It opens a warning that deletion is permanent and that the account and its information can't be recovered afterwards.

- To confirm, the user **types their email address** and enters their **password**. Accounts without a password confirm with one of their **passkeys** instead. Being signed in isn't enough, so someone using a computer that was left signed in can't delete the account.
- Wrong passwords count towards the same **lockout** as the sign-in form.
- The account is then **scheduled** for deletion **7 days** later (`deletionGraceDays` in `src/config.js`). Every device is signed out and the owner gets an email.
- During those 7 days the owner can **sign in and cancel** from the account page, and gets an email when they do. Recovery links still work, so the real owner can take back an account that someone else asked to delete.
- After 7 days the server **erases** the user (the hourly clean-up in `src/server.js`, so it happens within an hour of the deadline). Their sessions, passkeys and email links are removed with it, along with any failed sign-in counts. A final email confirms it. There's no undo, and the email address can be used again.

## Tests

```bash
npm test
```

Runs 178 checks in about 20 seconds, using Node's built-in test runner. Each test file starts its own copy of the app with an empty in-memory database, so your real `data/app.db` is never touched.

| File | What it checks |
|---|---|
| `tests/validation.test.js` | Sign-up rules for names, emails and passwords |
| `tests/register.test.js` | Sign-up: hashing, names, duplicate emails, bad input |
| `tests/signin.test.js` | Sign-in, sign-out, session cookies, expiry, the account page |
| `tests/lockout.test.js` | Locking an email address after 5 wrong passwords |
| `tests/rate-limit.test.js` | Per-network limits on sign-in, sign-up and the API |
| `tests/email.test.js` | Confirming the email: one-time links, no sign-in until confirmed, resending, cancelling a sign-up, deleting after 7 days |
| `tests/account-name.test.js` | Changing your name on the account page |
| `tests/email-change.test.js` | Changing the sign-in email: confirming it's you, both addresses emailed, taken addresses, cancelling, signing out everywhere |
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
| `src/schema.sql` | The tables: users, sessions, passkeys, email_tokens, login_attempts, webauthn_challenges |
| `src/init-db.js` | `npm run db:init`: creates the tables and lists them |
| `src/routes/register.js` | `POST /api/register`: checks the fields, hashes the password with Argon2id, saves the user |
| `src/routes/auth.js` | `POST /api/login`, `POST /api/logout`, `GET /api/me` |
| `src/sessions.js` | Session cookies: start, check on every request, end, clean up |
| `src/lockout.js` | Locks an email address after 5 wrong passwords (15 min, doubling up to 24 h) |
| `src/rate-limits.js` | Per-IP limits on sign-in, sign-up and the whole API |
| `src/csrf.js` | Blocks requests sent from other websites; API accepts JSON only |
| `src/config.js` | Settings read from `.env` |
| `src/mailer.js` | Sends email over SMTP (Mailpit locally, your email service in production). Logs show only a hint of the address |
| `src/emails.js` | The text of each email |
| `src/email-tokens.js` | One-time email links: create, check, use once |
| `src/routes/email.js` | `POST /api/verify-email`, `POST /api/cancel-signup`, `POST /api/resend-verification` |
| `src/routes/passkeys.js` | Passkey routes: add, list, remove, sign in |
| `src/passkeys.js` | Passkey and challenge storage |
| `src/routes/recovery.js` | `/api/recovery/*`: request a link, check it, set a new password, sign in |
| `src/routes/account.js` | `POST /api/account/deletion` (ask to delete, after confirming it's you), `DELETE` (cancel), `POST /api/account/confirm-options` (passkey check), `PATCH /api/account/name`, `/api/account/email/*` (changing the sign-in email) |
| `src/account-deletion.js` | Scheduling, cancelling and erasing accounts after the 7-day wait; deleting unconfirmed sign-ups after 7 days |
| `src/email-change.js` | Changing the sign-in email: request, confirm, cancel |
| `src/validation.js` | The sign-up rules (names, email, password) |
| `public/signup.html` | The sign-up page, at http://localhost:3000/signup |
| `public/signup.js` | Checks the form in the browser and sends it to the server |
| `public/signin.html`, `signin.js` | The sign-in page, at /signin |
| `public/verify-email.html`, `verify-email.js` | Opened from the confirmation email |
| `public/cancel-signup.html`, `cancel-signup.js` | "This wasn't me": cancels an unconfirmed sign-up |
| `public/confirm-email-change.html`, `.js` | Opened from the email sent to a new address |
| `public/cancel-email-change.html`, `.js` | Opened from the email sent to the old address |
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
10. ~~Account deletion with a 7-day grace period~~ ✓
11. ~~First and last names~~ ✓
12. ~~Sign in with email; usernames removed; unconfirmed accounts can't sign in and are deleted after 7 days~~ ✓
13. ~~Changing and confirming the sign-in email~~ ✓
