import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { config } from '../config.js';

const marked = new Marked({ gfm: true, breaks: true });

const siteHost = (() => {
  try {
    return new URL(config.siteUrl).host;
  } catch {
    return '';
  }
})();

function isInternal(href) {
  if (!href) return true;
  if (href.startsWith('/') || href.startsWith('#')) return true;
  try {
    return new URL(href).host === siteHost;
  } catch {
    return false;
  }
}

/**
 * Render user/AI markdown to safe HTML.
 * trusted=true (staff / automated account) keeps external links followable;
 * member content gets rel="nofollow ugc" to discourage link spam.
 */
export function renderMarkdown(source, { trusted = false } = {}) {
  const raw = marked.parse(String(source ?? ''));
  return sanitizeHtml(raw, {
    allowedTags: [
      'p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
      'a', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'kbd',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'target'],
      img: ['src', 'alt', 'title', 'loading'],
      code: ['class'],
      th: ['align'],
      td: ['align'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['https'] },
    allowedClasses: { code: [/^language-[\w-]+$/] },
    transformTags: {
      h1: 'h3',
      h2: 'h4',
      a: (tagName, attribs) => {
        const href = attribs.href || '';
        if (isInternal(href)) return { tagName, attribs: { href, ...(attribs.title ? { title: attribs.title } : {}) } };
        return {
          tagName,
          attribs: {
            ...attribs,
            target: '_blank',
            rel: trusted ? 'noopener' : 'nofollow ugc noopener',
          },
        };
      },
      img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy' } }),
    },
  });
}

/** Plain-text excerpt for meta descriptions, lists and AI prompts. */
export function plainExcerpt(source, max = 160) {
  const text = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : text;
}
