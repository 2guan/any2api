import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config.js';

export type Sealed = { ciphertext: string; iv: string; tag: string };

export function seal(value: unknown): Sealed {
  if (!config.encryptionKey) throw new Error('Credential storage requires ANY2API_ENCRYPTION_KEY');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

export function unseal<T>(sealed: Sealed): T {
  if (!config.encryptionKey) throw new Error('Credential storage requires ANY2API_ENCRYPTION_KEY');
  const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, Buffer.from(sealed.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as T;
}
