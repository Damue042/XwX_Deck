// S3 Signature V4 using explicitly supplied release credentials. This module
// never creates, saves, prints or searches for credentials.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const required = name => { const value = process.env[name]; if (!value) throw Error(`Missing required release setting: ${name}`); return value; };
export function createR2Store() {
  const account = required('CLOUDFLARE_ACCOUNT_ID');
  if (!/^[a-f0-9]{32}$/.test(account)) throw Error('Invalid Cloudflare account identifier');
  const access = required('R2_ACCESS_KEY_ID'), secret = required('R2_SECRET_ACCESS_KEY');
  const bucket = 'xwx-deck-downloads';
  async function request(method, key, options = {}) {
    const url = new URL(`https://${account}.r2.cloudflarestorage.com/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
    const at = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = at.slice(0, 8), scope = `${day}/auto/s3/aws4_request`;
    const headers = {'host': url.host, 'x-amz-date': at, 'x-amz-content-sha256': options.sha256 ?? hash('')};
    if (options.size !== undefined) {
      headers['content-length'] = String(options.size);
      headers['content-type'] = options.contentType;
      headers['cache-control'] = options.cacheControl;
      headers['x-amz-meta-sha256'] = options.sha256;
    }
    if (options.ifNoneMatch) headers['if-none-match'] = options.ifNoneMatch;
    if (options.ifMatch) headers['if-match'] = options.ifMatch;
    const names = Object.keys(headers).sort();
    const canonical = [method, url.pathname, '', names.map(name => `${name}:${headers[name].trim()}\n`).join(''), names.join(';'), headers['x-amz-content-sha256']].join('\n');
    const signing = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), 'auto'), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signing).update(`AWS4-HMAC-SHA256\n${at}\n${scope}\n${hash(canonical)}`).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    const response = await fetch(url, {method, headers, redirect: 'error', signal: AbortSignal.timeout(300000),
      ...(method === 'PUT' ? {body: options.path ? createReadStream(options.path) : options.bytes, duplex: 'half'} : {})});
    if (response.status === 404 && method !== 'PUT') return null;
    if (!response.ok) throw Error(`R2 ${method} failed with HTTP ${response.status}; no credential or error body logged`);
    return response;
  }
  return {
    async head(key) {
      const response = await request('HEAD', key);
      return response ? {size: Number(response.headers.get('content-length')), sha256: response.headers.get('x-amz-meta-sha256')} : null;
    },
    async get(key) {
      const response = await request('GET', key);
      if (!response) return null;
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; if (size > 1024 ** 2) throw Error('R2 update metadata exceeds limit'); chunks.push(chunk);
      }
      return {bytes: Buffer.concat(chunks), etag: response.headers.get('etag')};
    },
    async put(key, options) { await request('PUT', key, options); }
  };
}
