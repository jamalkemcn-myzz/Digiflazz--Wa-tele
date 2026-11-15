import fs from 'node:fs';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { config } from '../config/env';

export async function loadWhatsappAuthState() {
  if (!fs.existsSync(config.whatsapp.sessionDir)) {
    fs.mkdirSync(config.whatsapp.sessionDir, { recursive: true });
  }
  return useMultiFileAuthState(config.whatsapp.sessionDir);
}

export function hasSavedWhatsappSession(): boolean {
  try {
    if (!fs.existsSync(config.whatsapp.sessionDir)) return false;
    const files = fs.readdirSync(config.whatsapp.sessionDir);
    return files.includes('creds.json');
  } catch {
    return false;
  }
}

export function clearWhatsappSessionDir(): void {
  try {
    if (fs.existsSync(config.whatsapp.sessionDir)) {
      fs.rmSync(config.whatsapp.sessionDir, { recursive: true, force: true });
      fs.mkdirSync(config.whatsapp.sessionDir, { recursive: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}
