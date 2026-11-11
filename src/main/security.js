'use strict';
const crypto = require('crypto');

const PARAMS = { N: 16384, r: 8, p: 1 };
const DUMMY = hashPassword('senha-invalida-para-tempo-constante');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, PARAMS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [alg, saltHex, hashHex] = String(stored || DUMMY).split('$');
    if (alg !== 'scrypt') return false;
    const hash = Buffer.from(hashHex, 'hex');
    const test = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), hash.length, PARAMS);
    return crypto.timingSafeEqual(hash, test) && Boolean(stored);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
