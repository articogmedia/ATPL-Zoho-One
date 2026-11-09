import type { PDFFont } from "pdf-lib";

function splitLongWord(font: PDFFont, word: string, size: number, maxWidth: number) {
  if (font.widthOfTextAtSize(word, size) <= maxWidth) return [word];
  const segments = word.match(/[^+/]*[+/]?/g)?.filter(Boolean) ?? [word];
  const parts: string[] = [];
  for (const segment of segments) {
    if (font.widthOfTextAtSize(segment, size) <= maxWidth) {
      parts.push(segment);
      continue;
    }
    let part = "";
    for (const character of segment) {
      const next = part + character;
      if (part && font.widthOfTextAtSize(next, size) > maxWidth) {
        parts.push(part);
        part = character;
      } else {
        part = next;
      }
    }
    if (part) parts.push(part);
  }
  return parts;
}

export function wrapQuotationPdfText(font: PDFFont, value: string, size: number, maxWidth: number) {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const [wordIndex, word] of words.entries()) {
    const parts = splitLongWord(font, word, size, maxWidth);
    for (const [partIndex, part] of parts.entries()) {
      const separator = line && (wordIndex > 0 && partIndex === 0) ? " " : "";
      const next = line ? `${line}${separator}${part}` : part;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) line = next;
      else {
        if (line) lines.push(line);
        line = part;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}
