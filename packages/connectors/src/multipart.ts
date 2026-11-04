/** multipart/form-data body with text fields and one file part. */
export function multipartBody(fields: Record<string, string>, file: { field: string; name: string; mime: string; bytes: Uint8Array }): { body: Uint8Array; contentType: string } {
  const boundary = `----fg${crypto.randomUUID().replaceAll('-', '')}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.bytes, enc.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    body.set(p, o);
    o += p.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
