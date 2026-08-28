/** Return the UTF-8 wire size without allocating an encoded copy. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

/** Keep the longest code-point-safe prefix that fits a UTF-8 wire budget. */
export function truncateUTF8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const codePoint = value.codePointAt(end)!;
    const width = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes+width > maxBytes) break;
    bytes += width;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return end === value.length ? value : value.slice(0, end);
}
