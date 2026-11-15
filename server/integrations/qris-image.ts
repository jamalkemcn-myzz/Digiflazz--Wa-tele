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

  const response = await fetch(trimmed, {
    method: 'GET',
    headers: {
      Accept: 'image/png,image/jpeg,image/webp,image/*,*/*',
      'User-Agent': 'PPOB-Bot-Ecosystem/1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Gagal mengunduh gambar QRIS (HTTP ${response.status})`);
  }

  const arrayBuf = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  if (buffer.length === 0) {
    throw new Error('Gambar QRIS yang diunduh kosong');
  }
  return buffer;
}
