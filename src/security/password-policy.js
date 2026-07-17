import { promisify } from "node:util";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const scryptAsync = promisify(scrypt);
const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_HASH = "00".repeat(64);

export const MAX_PASSWORD_LENGTH = 256;
export const PASSWORD_POLICY_MESSAGE = "A senha deve ter entre 8 e 256 caracteres, incluindo uma letra maiuscula, um numero e um caractere especial.";

export function isValidPassword(password = "") {
  const value = String(password);
  return value.length >= 8
    && value.length <= MAX_PASSWORD_LENGTH
    && /\p{Lu}/u.test(value)
    && /\p{N}/u.test(value)
    && /[^\p{L}\p{N}\s]/u.test(value);
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await deriveKey(String(password), salt);
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  const [candidateSalt, candidateHash, ...extra] = String(storedHash || "").split(":");
  const validEncoding = extra.length === 0
    && /^[a-f0-9]{32}$/i.test(candidateSalt || "")
    && /^[a-f0-9]{128}$/i.test(candidateHash || "");
  const salt = validEncoding ? candidateSalt : DUMMY_SALT;
  const expected = Buffer.from(validEncoding ? candidateHash : DUMMY_HASH, "hex");
  const actual = await deriveKey(String(password), salt);
  return validEncoding && timingSafeEqual(expected, actual);
}

async function deriveKey(password, salt) {
  return Buffer.from(await scryptAsync(password, salt, 64));
}
