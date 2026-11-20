// Builds the Express app. server.js starts it; the tests start their own copies.
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { isProduction, trustProxy } from './config.js';
import { loadSession, requireSignInPage } from './sessions.js';
import { apiLimiter } from './rate-limits.js';
import { csrfProtection, requireJson } from './csrf.js';
import registerRoutes from './routes/register.js';
import authRoutes from './routes/auth.js';
import emailRoutes from './routes/email.js';
import passkeyRoutes from './routes/passkeys.js';
import recoveryRoutes from './routes/recovery.js';
import accountRoutes from './routes/account.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');                     // don't advertise the framework

  // In production, send anyone who arrives over plain HTTP to the HTTPS address.
  if (isProduction) {
    app.use((req, res, next) => {
      if (req.secure) return next();
      res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
    });
  }

  // Security headers. The Content Security Policy only lets the page load scripts,
  // styles and images from our own site, which blocks most injected-script attacks.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],                // nobody can put our pages in a frame
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    // HSTS: once a browser has seen us over HTTPS, it refuses plain HTTP for a year.
    strictTransportSecurity: isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
  }));

  app.use(express.json({ limit: '10kb' }));        // small limits stop huge request bodies
  app.use(loadSession);                            // sets req.user if signed in

  // Signed-in people don't need the sign-in or sign-up pages.
  app.get(['/signin', '/signup'], (req, res, next) => {
    if (req.user) return res.redirect('/account');
    next();
  });

  // Pages that need you to be signed in live in views/, not public/,
  // so they can only be reached through a route that checks the session.
  app.get('/account', requireSignInPage, (req, res) => {
    res.set('Cache-Control', 'no-store');          // don't show it from cache after signing out
    res.sendFile(path.join(here, '..', 'views', 'account.html'));
  });

  // The browser half of SimpleWebAuthn, served from our own site (the CSP only allows our own scripts).
  app.use('/vendor/simplewebauthn', express.static(
    path.join(here, '..', 'node_modules', '@simplewebauthn', 'browser', 'esm'),
  ));

  // Serves files in public/. "extensions" lets /signup load public/signup.html.
  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));

  // Quick check that the server and database are working.
  app.get('/health', (req, res) => {
    const { users } = db.prepare('SELECT COUNT(*) AS users FROM users').get();
    res.json({ ok: true, users });
  });

  app.use('/api', apiLimiter, csrfProtection, requireJson);
  app.use('/api', registerRoutes);
  app.use('/api', authRoutes);
  app.use('/api', emailRoutes);
  app.use('/api', passkeyRoutes);
  app.use('/api', recoveryRoutes);
  app.use('/api', accountRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Log the real error, but never send its details to the browser.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'The request was not valid JSON.' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'The request is too large.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
