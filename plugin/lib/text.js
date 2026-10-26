/**
 * Minimal HTML-to-text conversion for `vpn_fetch`.
 *
 * The Harness' built-in `web_fetch` renders HTML with a full DOM pipeline. This
 * plugin runs with zero dependencies, so it strips active content, keeps block
 * structure and decodes the common entities instead. The output is a readable
 * approximation, not a faithful rendering.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  laquo: '\u00ab',
  raquo: '\u00bb',
  middot: '\u00b7',
  times: '\u00d7',
  divide: '\u00f7',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  deg: '\u00b0',
}

export function decodeEntities(input) {
  if (typeof input !== 'string' || input === '') return ''
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? safeCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? safeCodePoint(code) : match
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? match : named
  })
}

function safeCodePoint(code) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return '\ufffd'
  if (code >= 0xd800 && code <= 0xdfff) return '\ufffd'
  try {
    return String.fromCodePoint(code)
  } catch {
    return '\ufffd'
  }
}

/** Extract the first `<title>` text, decoded and collapsed. */
export function extractTitle(html) {
  if (typeof html !== 'string') return ''
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (match === null) return ''
  return decodeEntities(match[1])
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Convert an HTML document to plain text.
 *
 * @param {string} html - the decoded response body.
 * @param {{ includeTitle?: boolean }} [options]
 * @returns {string}
 */
export function htmlToText(html, options = {}) {
  if (typeof html !== 'string' || html === '') return ''
  const title = extractTitle(html)

  let text = html
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(/<(script|style|noscript|svg|template|iframe|object|canvas)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  text = text.replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dt|dd|figcaption)\s*>/gi, '\n')
  text = text.replace(/<li\b[^>]*>/gi, '- ')
  text = text.replace(/<td\b[^>]*>/gi, '\t')
  text = text.replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)
  text = text.replace(/[ \t\f\v]+/g, ' ')
  text = text.replace(/ *\n */g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.trim()

  if (options.includeTitle === true && title !== '' && !text.startsWith(title)) {
    return `${title}\n\n${text}`
  }
  return text
}

/**
 * Cap a text to `maxChars` without splitting a surrogate pair.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateText(text, maxChars) {
  const value = typeof text === 'string' ? text : ''
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : value.length
  if (value.length <= limit) return { text: value, truncated: false }
  let end = limit
  const code = value.charCodeAt(end - 1)
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1
  return { text: value.slice(0, end), truncated: true }
}
