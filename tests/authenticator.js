// A software passkey for the tests: does what Face ID / Touch ID / a phone does,
// with a real P-256 key pair, so the server's checks run exactly as in real life.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const sha256 = (data) => createHash('sha256').update(data).digest();
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Minimal CBOR encoder (the binary format WebAuthn uses), enough for passkeys.
function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') { const b = Buffer.from(value); return Buffer.concat([head(3, b.length), b]); }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  return cbor(new Map(Object.entries(value)));
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_DATA = 0x40;

export class SoftPasskey {
  constructor({ origin = 'http://localhost:3000', rpID = 'localhost', synced = true } = {}) {
    this.origin = origin;
    this.rpID = rpID;
    this.synced = synced;
    this.credentialId = randomBytes(16);
    this.counter = 0;
    this.userHandle = null;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' });
  }

  get id() { return b64url(this.credentialId); }

  #flags(extra = 0) {
    const sync = this.synced ? FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP : 0;
    return FLAG_USER_PRESENT | FLAG_USER_VERIFIED | sync | extra;
  }

  #clientData(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: origin ?? this.origin, crossOrigin: false }));
  }

  // Like navigator.credentials.create(): make a passkey for the options the server sent.
  register(options, { origin } = {}) {
    this.userHandle = options.user.id;
    const coseKey = new Map([
      [1, 2], [3, -7], [-1, 1],                          // EC2 key, ES256, curve P-256
      [-2, Buffer.from(this.publicJwk.x, 'base64url')],
      [-3, Buffer.from(this.publicJwk.y, 'base64url')],
    ]);
    const idLength = Buffer.alloc(2); idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpID), Buffer.from([this.#flags(FLAG_ATTESTED_DATA)]), Buffer.alloc(4),
      Buffer.alloc(16), idLength, this.credentialId, cbor(coseKey),
    ]);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.#clientData('webauthn.create', options.challenge, origin)),
        attestationObject: b64url(cbor({ fmt: 'none', attStmt: new Map(), authData })),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  // Like navigator.credentials.get(): sign the server's challenge.
  authenticate(options, { origin, counter } = {}) {
    this.counter = counter ?? this.counter + 1;
    const count = Buffer.alloc(4); count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.rpID), Buffer.from([this.#flags()]), count]);
    const clientData = this.#clientData('webauthn.get', options.challenge, origin);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
