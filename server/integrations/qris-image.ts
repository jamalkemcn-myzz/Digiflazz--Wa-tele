import http from 'node:http';
import https from 'node:https';

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

function downloadBufferIpv4(targetUrl: string, timeoutMs: number, redirectsLeft = 3): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error('URL gambar QRIS tidak valid'));
      return;
    }

    const isHttp = parsed.protocol === 'http:';
    const requestFn = isHttp ? http.request : https.request;
    const req = requestFn(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttp ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        agent: false,
        family: 4,
        timeout: timeoutMs,
        headers: {
          Accept: 'image/png,image/jpeg,image/webp,image/*,*/*',
          'User-Agent': 'PPOB-Bot-Ecosystem/1.0',
          Connection: 'close',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          res.resume();
          const nextUrl = new URL(location, parsed).toString();
          downloadBufferIpv4(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`Gagal mengunduh gambar QRIS (HTTP ${status || 500})`));
            return;
          }
          const contentType = String(res.headers['content-type'] || '').toLowerCase();
          if (contentType.includes('text/html') || contentType.includes('application/json')) {
            reject(new Error(`URL QRIS mengembalikan tipe konten bukan gambar (${contentType})`));
            return;
          }
          const buffer = Buffer.concat(chunks);
          if (buffer.length === 0) {
            reject(new Error('Gambar QRIS yang diunduh kosong'));
            return;
          }
          resolve(buffer);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Unduh gambar QRIS timeout (${timeoutMs}ms)`));
    });
    req.on('error', (err) => {
      reject(err);
    });
    req.end();
  });
}

export async function fetchQrisImageBuffer(qrUrl: string, timeoutMs = 10_000): Promise<Buffer> {
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
      return await downloadBufferIpv4(downloadUrl, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('Gagal mengunduh gambar QRIS');
}
