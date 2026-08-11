import { db } from './db.js';
import { seal, unseal } from './crypto.js';

export type Credentials = Record<string, string>;

export function credentialsFor(accountId: string): Credentials {
  const row = db.prepare('SELECT ciphertext, iv, tag FROM account_credentials WHERE account_id = ?').get(accountId) as { ciphertext: string; iv: string; tag: string } | undefined;
  if (!row) throw new Error('Account credentials are missing');
  return unseal<Credentials>(row);
}

export function saveCredentials(accountId: string, credentials: Credentials) {
  const encrypted = seal(credentials);
  db.prepare(`UPDATE account_credentials SET ciphertext = ?, iv = ?, tag = ?, updated_at = ? WHERE account_id = ?`)
    .run(encrypted.ciphertext, encrypted.iv, encrypted.tag, Date.now(), accountId);
}
