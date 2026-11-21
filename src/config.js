// Settings, read from environment variables (or the .env file).

export const isProduction = process.env.NODE_ENV === 'production';

export const port = Number(process.env.PORT ?? 3000);

// The site's public address, e.g. https://login.example.com.
// Used to check where requests come from (CSRF protection).
// If not set, the address the browser used to reach us is used.
export const appOrigin = process.env.APP_ORIGIN?.replace(/\/$/, '') || null;

// Set when the app runs behind a proxy or hosting platform that handles HTTPS
// (Caddy, nginx, Render, Fly.io...). Lets Express see the visitor's real IP
// address and whether they connected over HTTPS. Use the number of proxies, usually 1.
export const trustProxy = process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false;

// Optional: serve HTTPS directly from Node using certificate files (e.g. made with mkcert).
export const httpsKeyFile = process.env.HTTPS_KEY_FILE || null;
export const httpsCertFile = process.env.HTTPS_CERT_FILE || null;

// --- Email ---------------------------------------------------------------
// Who emails come from. In production use an address on your verified domain,
// e.g. "Kenya Chan <no-reply@mail.kenyachan.dev>".
export const emailFrom = process.env.EMAIL_FROM || 'Login Screen <no-reply@localhost>';

// Where to hand emails over. The default is Mailpit running on your computer,
// which catches every email so nothing is really sent. In production, use your
// email service's SMTP address, e.g. smtps://resend:YOUR_API_KEY@smtp.resend.com:465
export const smtpUrl = process.env.SMTP_URL || 'smtp://127.0.0.1:1025';

// "test" keeps emails in memory for the automated tests instead of sending them.
export const emailTransport = process.env.EMAIL_TRANSPORT || 'smtp';

// The start of every link we put in an email. It never comes from the request,
// so nobody can trick the server into emailing links to their own website.
export const linkBase = appOrigin ?? `http://localhost:${port}`;

if (isProduction && !appOrigin) {
  throw new Error('Set APP_ORIGIN in production, e.g. APP_ORIGIN=https://kenyachan.dev');
}

// --- Deleting accounts -----------------------------------------------------
// How long an account waits after the owner asks to delete it, so they can change their mind.
export const deletionGraceDays = 7;

// Accounts whose email address still isn't confirmed this long after sign-up are deleted.
export const unconfirmedAccountDays = 7;

// --- Passkeys --------------------------------------------------------------
// Passkeys are tied to a domain (the "relying party ID"). They're created for
// the host in APP_ORIGIN (kenyachan.dev in production, localhost on your computer)
// and only work there, which is what makes them impossible to phish.
export const rpID = new URL(linkBase).hostname;
export const rpName = process.env.RP_NAME || 'Login Screen';
export const expectedOrigin = new URL(linkBase).origin;
