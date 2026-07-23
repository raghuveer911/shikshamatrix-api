import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function isEmail(identifier: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
}

export function isPhone(identifier: string): boolean {
  return /^[6-9]\d{9}$/.test(identifier.replace(/\s+/g, ""));
}

export function normalizePhone(phone: string): string {
  // Remove spaces, dashes, +91 prefix
  let normalized = phone.replace(/\s+/g, "").replace(/-/g, "");
  if (normalized.startsWith("+91")) normalized = normalized.slice(3);
  if (normalized.startsWith("91") && normalized.length === 12) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

export function generateReceiptNumber(prefix: string = "RCP"): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}