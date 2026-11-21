// Starts the app: run with `npm start` or `npm run dev`.
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { httpsCertFile, httpsKeyFile, port } from './config.js';
import { deleteExpiredSessions } from './sessions.js';
import { deleteOldAttempts } from './lockout.js';
import { deleteOldEmailTokens } from './email-tokens.js';
import { deleteOldChallenges } from './passkeys.js';
import { deleteUnconfirmedAccounts, purgeDueAccounts } from './account-deletion.js';

const app = createApp();

// Tidy up old sessions, failed-attempt records and email links now and every hour,
// erase accounts whose 7-day deletion grace period has ended, and delete
// sign-ups that still haven't confirmed their email after 7 days.
function cleanUp() {
  purgeDueAccounts();
  deleteUnconfirmedAccounts();
  deleteExpiredSessions();
  deleteOldAttempts();
  deleteOldEmailTokens();
  deleteOldChallenges();
}
cleanUp();
setInterval(cleanUp, 60 * 60 * 1000).unref();

// Serve HTTPS directly if certificate files are given; otherwise plain HTTP
// (fine on localhost, or behind a proxy that handles HTTPS in production).
const server = httpsKeyFile && httpsCertFile
  ? https.createServer({ key: readFileSync(httpsKeyFile), cert: readFileSync(httpsCertFile) }, app)
  : http.createServer(app);

server.listen(port, () => {
  const scheme = server instanceof https.Server ? 'https' : 'http';
  console.log(`Server running at ${scheme}://localhost:${port}`);
});
