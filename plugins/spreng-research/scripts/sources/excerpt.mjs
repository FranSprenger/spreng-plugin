/** Preserve a bounded field's complete value in a document and label its excerpt. */
export function documentExcerpt(result, text, max, title, url) {
  if (!text || text.length <= max) return text;
  const documents = result.documents ||= [];
  title = `${title} (${documents.length + 1})`;
  documents.push({ title, kind: 'other', text, url });
  const note = `\n[excerpt; remainder omitted here; full text in document "${title}"]`;
  let end = max - note.length;
  // The validator counts UTF-16 units; keep an astral character whole at the boundary.
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end) + note;
}
