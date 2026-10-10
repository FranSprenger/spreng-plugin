/** Keep long source text as a document and identify the bounded quote as an excerpt. */
export function addQuote(result, quote) {
  if (quote.text.length > 4000) {
    const documents = result.documents ||= [];
    const title = `${result.label} item ${result.quotes.length + 1}`;
    documents.push({ title, kind: 'other', text: quote.text, url: quote.url });
    // The schema counts UTF-16 units; keep an astral character whole at the excerpt boundary.
    const end = /[\uD800-\uDBFF]/.test(quote.text[3999]) ? 3999 : 4000;
    const note = `; excerpt: first ${end} of ${quote.text.length} UTF-16 code units; full text in document "${title}"`;
    quote = { ...quote, text: quote.text.slice(0, end), context: `${(quote.context || '').slice(0, 1000 - note.length)}${note}` };
  }
  result.quotes.push(quote);
}
