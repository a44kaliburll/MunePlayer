// MTPZ key material: the "Zune Software" application certificate and RSA key that a Zune
// asks for before it accepts new files. It is not part of this repository. Mune Player
// looks for it here, in order:
//
//   %USERPROFILE%\.mtpz-data                   libmtp's format: exponent, encryption key,
//                                              modulus, private key, certificates (one hex
//                                              string per line)
//   %USERPROFILE%\.mune-player\mtpz-keys.json  { "exponent", "modulus", "privateKey",
//                                                "certificates" } as hex strings
//
// Without it everything works except copying music to a Zune (reading one is fine).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function loadMtpzKeys() {
  const home = os.homedir();
  const libmtp = path.join(home, '.mtpz-data');
  try {
    const lines = fs.readFileSync(libmtp, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 5) {
      return { exponent: lines[0], modulus: lines[2], privateKey: lines[3], certificates: Buffer.from(lines[4], 'hex'), source: libmtp };
    }
  } catch {}
  const json = path.join(home, '.mune-player', 'mtpz-keys.json');
  try {
    const k = JSON.parse(fs.readFileSync(json, 'utf8'));
    if (k.exponent && k.modulus && k.privateKey && k.certificates) {
      return { exponent: k.exponent, modulus: k.modulus, privateKey: k.privateKey, certificates: Buffer.from(k.certificates, 'hex'), source: json };
    }
  } catch {}
  return null;
}
