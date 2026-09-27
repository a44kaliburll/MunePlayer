// MTPZ: the handshake a Zune requires before it accepts new files. Ported from
// zune-explorer's mtpz-auth.js (MIT, github.com/NiceBeard/zune-explorer), which
// follows libmtp's implementation. Here the MTP operations travel through
// Microsoft's Zune driver (raw pass-through), so no driver swap is needed.
import crypto from 'node:crypto';
import { loadMtpzKeys } from './mtpz-keys.js';

const RSA_BLOCK = 128;
const OP = {
  SetDevicePropValue: 0x1016,
  SendWMDRMPDAppRequest: 0x9212,
  GetWMDRMPDAppResponse: 0x9213,
  EnableTrustedFilesOperations: 0x9214,
  EndTrustedAppSession: 0x9216,
};
const RESPONSE_OK = 0x2001;

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function mgf1Sha1(seed, length) {
  const chunks = [];
  for (let counter = 0; counter < Math.ceil(length / 20) + 1; counter++) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter, 0);
    chunks.push(crypto.createHash('sha1').update(seed).update(c).digest());
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function aesEcb(key, block) {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}

function shiftLeft(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length - 1; i++) out[i] = ((buf[i] << 1) | (buf[i + 1] >> 7)) & 0xff;
  out[buf.length - 1] = (buf[buf.length - 1] << 1) & 0xff;
  return out;
}

/** AES-CMAC (RFC 4493) for a single block of input. */
function aesCmac(key, data) {
  const L = aesEcb(key, Buffer.alloc(16));
  const K1 = shiftLeft(L);
  if (L[0] & 0x80) K1[15] ^= 0x87;
  const K2 = shiftLeft(K1);
  if (K1[0] & 0x80) K2[15] ^= 0x87;
  const block = Buffer.alloc(16);
  if (data.length === 16) {
    for (let i = 0; i < 16; i++) block[i] = data[i] ^ K1[i];
  } else {
    data.copy(block, 0, 0, data.length);
    block[data.length] = 0x80;
    for (let i = 0; i < 16; i++) block[i] ^= K2[i];
  }
  return aesEcb(key, block);
}

function mtpString(str) {
  const withNull = `${str}\0`;
  const buf = Buffer.alloc(1 + withNull.length * 2);
  buf.writeUInt8(withNull.length, 0);
  buf.write(withNull, 1, 'utf16le');
  return buf;
}

export class MtpzAuth {
  constructor(bridge) {
    this.bridge = bridge;
    this.keys = loadMtpzKeys();
  }

  async #op(op, { params = [], data, read = false } = {}) {
    const res = await this.bridge.request('mtp', { op, params, ...(data ? { data: data.toString('base64') } : {}), read });
    if (res.responseCode !== RESPONSE_OK) {
      const err = new Error(`MTP 0x${op.toString(16)} answered 0x${res.responseCode.toString(16)}`);
      err.responseCode = res.responseCode;
      throw err;
    }
    return read ? Buffer.from(res.data || '', 'base64') : null;
  }

  #rsaPrivate(block) {
    const m = BigInt(`0x${block.toString('hex')}`);
    const r = modPow(m, BigInt(`0x${this.keys.privateKey}`), BigInt(`0x${this.keys.modulus}`));
    return Buffer.from(r.toString(16).padStart(RSA_BLOCK * 2, '0'), 'hex');
  }

  #appCertificateMessage() {
    const certs = this.keys.certificates;
    const random = crypto.randomBytes(16);
    const preSignLen = 5 + 2 + certs.length + 2 + 16;
    const msg = Buffer.alloc(preSignLen + 3 + RSA_BLOCK);
    let o = 0;
    msg[o++] = 0x02;
    msg[o++] = 0x01;
    msg[o++] = 0x01;
    msg[o++] = 0x00;
    msg[o++] = 0x00;
    msg.writeUInt16BE(certs.length, o);
    o += 2;
    certs.copy(msg, o);
    o += certs.length;
    msg[o++] = 0x00;
    msg[o++] = 0x10;
    random.copy(msg, o);
    o += 16;
    msg[o++] = 0x01;
    msg[o++] = 0x00;
    msg[o++] = 0x80;
    // PSS-style signature over bytes [2, preSignLen)
    const inner = crypto.createHash('sha1').update(msg.subarray(2, preSignLen)).digest();
    const v = Buffer.alloc(28);
    inner.copy(v, 8);
    const hash = crypto.createHash('sha1').update(v).digest();
    const mask = mgf1Sha1(hash, 107);
    const block = Buffer.alloc(RSA_BLOCK);
    block[106] = 0x01;
    hash.copy(block, 107);
    for (let i = 0; i < 107; i++) block[i] ^= mask[i];
    block[0] &= 0x7f;
    block[127] = 0xbc;
    this.#rsaPrivate(block).copy(msg, o);
    return { msg, random };
  }

  #parseResponse(res, random) {
    if (res[0] !== 0x02 || res[1] !== 0x02 || res[3] !== 0x80) throw new Error(`unexpected MTPZ response header ${res.subarray(0, 4).toString('hex')}`);
    const dec = this.#rsaPrivate(res.subarray(4, 4 + RSA_BLOCK));
    const seedMask = mgf1Sha1(dec.subarray(21, RSA_BLOCK), 20);
    for (let i = 0; i < 20; i++) dec[1 + i] ^= seedMask[i];
    const dataMask = mgf1Sha1(dec.subarray(1, 21), 107);
    for (let i = 0; i < 107; i++) dec[21 + i] ^= dataMask[i];
    const sessionKey = Buffer.from(dec.subarray(112, RSA_BLOCK));
    const aesLen = res.readUInt16BE(134);
    if (!aesLen || aesLen % 16) throw new Error(`bad MTPZ payload length ${aesLen}`);
    const d = crypto.createDecipheriv('aes-128-cbc', sessionKey, Buffer.alloc(16));
    d.setAutoPadding(false);
    const plain = Buffer.concat([d.update(res.subarray(136, 136 + aesLen)), d.final()]);
    let o = 1;
    o += 4 + plain.readUInt32BE(o); // device certificates
    const randLen = plain.readUInt16BE(o);
    o += 2;
    if (!plain.subarray(o, o + randLen).equals(random)) throw new Error('the Zune did not echo our challenge');
    o += randLen;
    o += 2 + plain.readUInt16BE(o); // device random
    o += 1;
    o += 2 + plain.readUInt16BE(o); // signature
    o += 1;
    const macLen = plain.readUInt16BE(o);
    o += 2;
    return Buffer.from(plain.subarray(o, o + macLen));
  }

  /** Runs the handshake; afterwards the device accepts new objects for this session. */
  async authenticate() {
    if (!this.keys) {
      throw new Error('Copying to a Zune needs the MTPZ key file (see "Syncing a Zune" in the README).');
    }
    // The Zune firmware wants a SessionInitiatorInfo mentioning MTPZClassDriver (libmtp sends its own name too).
    try {
      await this.#op(OP.SetDevicePropValue, { params: [0xd406], data: mtpString('Zoon Player - MTPZClassDriver') });
    } catch {
      // Microsoft's driver has usually set it already.
    }
    try {
      await this.#op(OP.EndTrustedAppSession);
    } catch {}
    const { msg, random } = this.#appCertificateMessage();
    await this.#op(OP.SendWMDRMPDAppRequest, { data: msg });
    const response = await this.#op(OP.GetWMDRMPDAppResponse, { read: true });
    const macHash = this.#parseResponse(response, random);
    const seed = Buffer.alloc(16);
    seed[15] = 0x01;
    const confirmation = Buffer.alloc(20);
    confirmation[0] = 0x02;
    confirmation[1] = 0x03;
    confirmation[2] = 0x00;
    confirmation[3] = 0x10;
    aesCmac(macHash.subarray(0, 16), seed).copy(confirmation, 4);
    await this.#op(OP.SendWMDRMPDAppRequest, { data: confirmation });
    const cmac = aesCmac(macHash.subarray(0, 16), macHash.subarray(16, 20));
    await this.#op(OP.EnableTrustedFilesOperations, {
      params: [cmac.readUInt32BE(0), cmac.readUInt32BE(4), cmac.readUInt32BE(8), cmac.readUInt32BE(12)],
    });
    return true;
  }
}
