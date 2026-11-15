export function appendRawFormatToQrisUrl(qrUrl: string): string {
  const trimmed = qrUrl.trim();
  if (!trimmed || trimmed.startsWith('data:')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.searchParams.get('format') !== 'raw') {
      parsed.searchParams.set('format', 'raw');
    }
    return parsed.toString();
  } catch {
    if (/[?&]format=raw(?:&|$)/i.test(trimmed)) {
      return trimmed;
    }
    return `${trimmed}${trimmed.includes('?') ? '&' : '?'}format=raw`;
  }
}

export async function fetchQrisImageBuffer(qrUrl: string, timeoutMs = 15_000): Promise<Buffer> {
  const trimmed = qrUrl.trim();
  if (!trimmed) {
    throw new Error('URL gambar QRIS kosong');
  }

  if (trimmed.startsWith('data:')) {
    const commaIdx = trimmed.indexOf(',');
    if (commaIdx === -1) {
      throw new Error('Data URL QRIS tidak valid');
    }
    const base64Part = trimmed.slice(commaIdx + 1);
    const buf = Buffer.from(base64Part, 'base64');
    if (buf.length === 0) {
      throw new Error('Buffer data URL QRIS kosong');
    }
    return buf;
  }

  const downloadUrl = appendRawFormatToQrisUrl(trimmed);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(downloadUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Accept: 'image/png,image/jpeg,image/webp,image/*,*/*',
          'User-Agent': 'PPOB-Bot-Ecosystem/1.0',
          Connection: 'close',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Gagal mengunduh gambar QRIS (HTTP ${response.status})`);
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        throw new Error(`URL QRIS mengembalikan tipe konten bukan gambar (${contentType})`);
      }

      const arrayBuf = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      if (buffer.length === 0) {
        throw new Error('Gambar QRIS yang diunduh kosong');
      }
      return buffer;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('Gagal mengunduh gambar QRIS');
}
