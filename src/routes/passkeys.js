// Passkeys (WebAuthn). The flow is the same for adding a passkey and signing in:
//   1. options: the server makes a random one-time challenge
//   2. the browser asks the device, which unlocks with Face ID / fingerprint / PIN
//      and signs the challenge with the passkey's private key
//   3. verify: the server checks the signature with the saved public key
// SimpleWebAuthn does the cryptography; this file does the bookkeeping.

import { Router } from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { requireSignIn, startSession } from '../sessions.js';
import { loginLimiter } from '../rate-limits.js';
import { expectedOrigin, rpID, rpName } from '../config.js';
import {
  NICKNAME_MAX, addPasskey, challengeFrom, cleanNickname, describePasskey, findPasskey, getPasskeyUser, guessDeviceName,
  listPasskeys, markPasskeyUsed, parseTransports, passkeyCount, removePasskey, renamePasskey, saveChallenge,
  takeChallenge,
} from '../passkeys.js';

const router = Router();

const EXPIRED = { error: 'This request has expired. Please try again.' };
const SIGN_IN_FAILED = { error: "That passkey couldn't be used to sign in." };

// --- Adding a passkey (signed in) -----------------------------------------

// POST /api/passkeys/register/options
router.post('/passkeys/register/options', requireSignIn, async (req, res) => {
  const user = getPasskeyUser(req.user.id);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userDisplayName: user.username,
    userID: new Uint8Array(Buffer.from(user.webauthn_user_id, 'base64url')),
    attestationType: 'none',
    // Don't let the same device add a second passkey for this account.
    excludeCredentials: listPasskeys(user.id).map((p) => ({
      id: p.credential_id,
      transports: parseTransports(p.transports),
    })),
    authenticatorSelection: {
      residentKey: 'required',          // a real passkey: the device remembers the account
      userVerification: 'required',     // must unlock with Face ID, fingerprint or PIN
    },
  });
  saveChallenge(options.challenge, 'register', user.id);
  res.json(options);
});

// POST /api/passkeys/register/verify  { response }
router.post('/passkeys/register/verify', requireSignIn, async (req, res) => {
  const response = req.body?.response;
  const challenge = challengeFrom(response);
  if (!challenge || !takeChallenge(challenge, 'register', req.user.id)) {
    return res.status(400).json(EXPIRED);
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return res.status(400).json({ error: "That passkey couldn't be added." });
  }
  if (!verification.verified) {
    return res.status(400).json({ error: "That passkey couldn't be added." });
  }

  const info = verification.registrationInfo;
  const nickname = info.passkeyProviderMetadata?.name ?? guessDeviceName(req.get('user-agent'));
  try {
    const id = addPasskey(req.user.id, info, nickname);
    const added = listPasskeys(req.user.id).find((p) => p.id === id);
    res.status(201).json(describePasskey(added));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'This passkey is already on an account.' });
    }
    throw err;
  }
});

// GET /api/passkeys
router.get('/passkeys', requireSignIn, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(listPasskeys(req.user.id).map(describePasskey));
});

// PATCH /api/passkeys/:id  { nickname }
router.patch('/passkeys/:id', requireSignIn, (req, res) => {
  const id = Number(req.params.id);
  const nickname = cleanNickname(req.body?.nickname);
  if (!nickname) {
    return res.status(400).json({ error: `Give the passkey a name of 1–${NICKNAME_MAX} characters.` });
  }
  if (!Number.isInteger(id) || !renamePasskey(id, req.user.id, nickname)) {
    return res.status(404).json({ error: 'Passkey not found.' });
  }
  const renamed = listPasskeys(req.user.id).find((p) => p.id === id);
  res.json(describePasskey(renamed));
});

// DELETE /api/passkeys/:id
router.delete('/passkeys/:id', requireSignIn, (req, res) => {
  const id = Number(req.params.id);
  const user = getPasskeyUser(req.user.id);
  const mine = listPasskeys(user.id).some((p) => p.id === id);
  if (!Number.isInteger(id) || !mine) {
    return res.status(404).json({ error: 'Passkey not found.' });
  }
  // Never remove someone's last way to sign in.
  if (!user.password_hash && passkeyCount(user.id) === 1) {
    return res.status(409).json({ error: "This is your only way to sign in, so it can't be removed." });
  }
  removePasskey(id, user.id);
  res.status(204).end();
});

// --- Signing in with a passkey (not signed in) ----------------------------

// POST /api/passkeys/login/options
router.post('/passkeys/login/options', async (req, res) => {
  // No list of allowed passkeys: the device offers whichever passkeys it has for
  // this site, so the user doesn't even need to type a username.
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  saveChallenge(options.challenge, 'login');
  res.json(options);
});

// POST /api/passkeys/login/verify  { response }
router.post('/passkeys/login/verify', loginLimiter, async (req, res) => {
  const response = req.body?.response;
  const challenge = challengeFrom(response);
  if (!challenge || !takeChallenge(challenge, 'login')) {
    return res.status(400).json(EXPIRED);
  }

  const passkey = findPasskey(response?.id);
  if (!passkey) return res.status(401).json(SIGN_IN_FAILED);

  // The device also says which account the passkey belongs to; it must agree.
  const userHandle = response.response?.userHandle;
  if (userHandle && userHandle !== passkey.webauthn_user_id) {
    return res.status(401).json(SIGN_IN_FAILED);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.sign_count,
        transports: parseTransports(passkey.transports),
      },
    });
  } catch {
    // Includes a signature counter going backwards: a sign the passkey was copied.
    return res.status(401).json(SIGN_IN_FAILED);
  }
  if (!verification.verified) return res.status(401).json(SIGN_IN_FAILED);

  const { newCounter, credentialBackedUp } = verification.authenticationInfo;
  markPasskeyUsed(passkey.id, newCounter, credentialBackedUp);
  startSession(req, res, passkey.user_id);
  res.json({ username: passkey.username });
});

export default router;
