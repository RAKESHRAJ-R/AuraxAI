import path from 'path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';

/**
 * Text extraction + chunking for the Knowledge Hub's document/website sources.
 *
 * Turns an uploaded file (PDF/DOCX/TXT/MD/HTML) or a fetched web page into plain
 * text, then splits that text into overlapping chunks small enough to inject into
 * an LLM prompt. Chunks are what the retrieval layer actually searches — a whole
 * 12-page size-chart PDF would blow the token budget, a 900-char slice of it won't.
 *
 * Chunking splits on paragraph boundaries first and only hard-splits a paragraph
 * that is itself oversized, so a size chart or policy clause usually survives
 * intact in one chunk instead of being cut mid-sentence.
 */

const CHUNK_CHARS = 900;    // ~225 tokens — a few of these fit comfortably in the prompt
const CHUNK_OVERLAP = 150;  // carry-over so an answer straddling a boundary isn't lost
const MIN_CHUNK_CHARS = 40; // below this it's a heading fragment, not useful context

const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.html', '.htm'];

class TextExtractService {
  get supportedExtensions() {
    return [...SUPPORTED_EXTENSIONS];
  }

  isSupported(filename) {
    return SUPPORTED_EXTENSIONS.includes(path.extname(filename || '').toLowerCase());
  }

  /**
   * Collapse the whitespace soup that PDF and HTML extraction always produces.
   * Keeps paragraph breaks (they drive chunking) but flattens everything else.
   */
  normalize(raw) {
    return String(raw || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Strip an HTML document down to readable body text. */
  fromHtml(html) {
    const $ = cheerio.load(html || '');
    // Nav/script/style/footer text is boilerplate repeated on every page — indexing
    // it would make every chunk look similar and poison retrieval.
    $('script, style, noscript, nav, header, footer, svg, iframe, form').remove();
    const title = $('title').first().text().trim();
    // Block elements need an explicit break or the text runs together into one line.
    $('p, div, li, br, h1, h2, h3, h4, h5, h6, tr').append('\n');
    const body = $('body').length ? $('body').text() : $.root().text();
    return { title, text: this.normalize(body) };
  }

  /**
   * Extract plain text from a file buffer. Returns { text, title, pages }.
   * Throws on unsupported extensions and on files that yield no readable text
   * (a scanned/image-only PDF is the common case — worth telling the owner
   * explicitly rather than silently indexing nothing).
   */
  async fromBuffer(buffer, filename) {
    const ext = path.extname(filename || '').toLowerCase();
    let text = '';
    let title = path.basename(filename || 'document', ext);
    let pages = null;

    switch (ext) {
      case '.pdf': {
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try {
          const result = await parser.getText();
          text = this.normalize(result.text);
          pages = Array.isArray(result.pages) ? result.pages.length : null;
        } finally {
          // pdf-parse holds a worker open; leaking one per upload would slowly
          // eat the box's memory.
          await parser.destroy().catch(() => {});
        }
        break;
      }
      case '.docx': {
        const result = await mammoth.extractRawText({ buffer });
        text = this.normalize(result.value);
        break;
      }
      case '.txt':
      case '.md': {
        text = this.normalize(buffer.toString('utf-8'));
        break;
      }
      case '.html':
      case '.htm': {
        const parsed = this.fromHtml(buffer.toString('utf-8'));
        text = parsed.text;
        if (parsed.title) title = parsed.title;
        break;
      }
      default:
        throw new Error(`Unsupported file type "${ext || 'unknown'}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
    }

    if (!text || text.length < MIN_CHUNK_CHARS) {
      throw new Error(
        ext === '.pdf'
          ? 'No readable text found — this looks like a scanned/image-only PDF. Re-export it as a text PDF, or add the details as a Q&A instead.'
          : 'No readable text found in this file.'
      );
    }

    return { text, title, pages };
  }

  /**
   * Split text into overlapping chunks. Paragraphs are kept whole where possible;
   * a paragraph longer than the chunk size is hard-split on sentence boundaries.
   */
  chunk(text, { maxChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
    const clean = this.normalize(text);
    if (!clean) return [];

    const pieces = [];
    for (const para of clean.split(/\n{2,}/)) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      if (trimmed.length <= maxChars) {
        pieces.push(trimmed);
        continue;
      }
      // Oversized paragraph — break it on sentence ends so chunks stay readable.
      let buffer = '';
      for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
        if (buffer && (buffer.length + sentence.length + 1) > maxChars) {
          pieces.push(buffer.trim());
          buffer = '';
        }
        // A single sentence longer than a whole chunk (tables, run-on lists) has
        // no natural break left — slice it.
        if (sentence.length > maxChars) {
          for (let i = 0; i < sentence.length; i += maxChars) {
            pieces.push(sentence.slice(i, i + maxChars).trim());
          }
          continue;
        }
        buffer += (buffer ? ' ' : '') + sentence;
      }
      if (buffer.trim()) pieces.push(buffer.trim());
    }

    // Pack pieces up to the size limit, carrying the tail of the previous chunk
    // forward as overlap.
    const chunks = [];
    let current = '';
    for (const piece of pieces) {
      if (current && (current.length + piece.length + 2) > maxChars) {
        chunks.push(current.trim());
        current = overlap > 0 ? current.slice(-overlap) + '\n\n' : '';
      }
      current += (current ? '\n\n' : '') + piece;
    }
    if (current.trim()) chunks.push(current.trim());

    return chunks.filter((c) => c.length >= MIN_CHUNK_CHARS);
  }
}

const textExtractService = new TextExtractService();
export default textExtractService;
