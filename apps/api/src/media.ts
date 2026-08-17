import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultDataDir = resolve(__dirname, '../../../data');
const dataDir = resolve(process.env.ANY2API_DATA_DIR ?? defaultDataDir);
const mediaDir = resolve(dataDir, 'media');
mkdirSync(mediaDir, { recursive: true });

export async function saveRemoteMedia(url: string, prefix = 'img', headers: Record<string, string> = {}): Promise<string> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return url;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = res.headers.get('content-type') || 'image/png';
    const ext = contentType.includes('png') ? 'png' : (contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : (contentType.includes('webp') ? 'webp' : 'png'));
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = resolve(mediaDir, filename);
    writeFileSync(filePath, buffer);
    return `/api/media/${filename}`;
  } catch {
    return url;
  }
}

export function saveBufferMedia(buffer: Buffer, ext = 'png', prefix = 'img'): string {
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filePath = resolve(mediaDir, filename);
  writeFileSync(filePath, buffer);
  return `/api/media/${filename}`;
}

export function getMediaFile(filename: string): { path: string; exists: boolean } {
  const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '');
  const filePath = resolve(mediaDir, safeName);
  return { path: filePath, exists: existsSync(filePath) };
}
