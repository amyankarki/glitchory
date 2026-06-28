import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { OAuth2Client } from 'google-auth-library';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ============================================
//  CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
const MONGODB_URI = process.env.MONGODB_URI || '';   // set this on your host
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';  // for comment sign-in
const SITE_URL = (process.env.SITE_URL || 'https://glitchory.com').replace(/\/+$/, '');
const DB_NAME = 'glitchory';
// ============================================

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const DEFAULT_CATEGORIES = [
  { id: 1, name: 'Tech News', slug: 'tech-news', description: 'Latest technology updates' },
  { id: 2, name: 'Gaming', slug: 'gaming', description: 'Video games and gaming news' },
  { id: 3, name: 'Reviews', slug: 'reviews', description: 'Product and game reviews' }
];

let db = null;          // MongoDB database handle
let articlesCol = null;
let commentsCol = null;
let metaCol = null;     // stores settings + the id counter

function slugify(title) {
  return (title || '').toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================
//  SERVER-SIDE RENDERING (for SEO / crawlers)
//  The browser still uses React + marked.js for the rich, interactive version.
//  These helpers put REAL, readable content into the first HTML response so
//  Google, AdSense and social scrapers don't see an empty page. React clears
//  #root and takes over the moment it loads, so users get the normal app —
//  and if the scripts ever fail to load, visitors still see the article
//  instead of a blank screen.
// ============================================

// ---------------------------------------------------------------------------
//  Markdown + safe-HTML -> HTML  (server side, for SEO / first paint)
//  This now mirrors the browser's marked.js so the two renderers stop
//  disagreeing: real tables, raw HTML pass-through (so a table or highlight box
//  copy-pasted straight from a doc survives instead of being escaped to text),
//  and a ==highlight== shortcut. Article content is written ONLY by the
//  authenticated admin, so HTML is allowed; we still strip the genuinely
//  dangerous bits (scripts / iframes / inline event handlers) as a safety net.
// ---------------------------------------------------------------------------

// Strip the dangerous parts out of admin-authored HTML.
function sanitizeHtml(s) {
  return String(s || '')
    .replace(/<\s*(script|style|iframe|object|embed|form)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

// Escape ONLY stray "<" and "&" in plain text, leaving real HTML tags intact
// (this is roughly how marked treats inline HTML).
function softEscape(s) {
  return String(s)
    .replace(/&(?!#?[a-zA-Z0-9]+;)/g, '&amp;')
    .replace(/<(?![a-zA-Z/!])/g, '&lt;');
}

// Block-level HTML tags we pass through verbatim when a paragraph starts with one.
const BLOCK_HTML_RE = /^<(table|thead|tbody|tfoot|tr|td|th|div|section|article|aside|figure|figcaption|details|summary|blockquote|pre|ul|ol|li|hr|img|picture|p|h[1-6]|header|footer|nav|mark|dl|dt|dd|center)\b/i;
const VOID_TAGS = new Set(['hr', 'img', 'br', 'input', 'source', 'col', 'picture']);

// Grab a complete top-level HTML element starting at `start`, balancing its own
// open/close tags so a multi-line table (even with blank lines inside) stays whole.
function captureHtmlBlock(lines, start) {
  const tag = lines[start].trim().match(/^<([a-z0-9]+)/i)[1].toLowerCase();
  if (VOID_TAGS.has(tag)) return { html: lines[start], next: start + 1 };
  const openRe = new RegExp('<' + tag + '\\b', 'gi');
  const closeRe = new RegExp('</' + tag + '\\b', 'gi');
  let depth = 0, buf = [], i = start;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    depth += (ln.match(openRe) || []).length - (ln.match(closeRe) || []).length;
    buf.push(ln);
    if (depth <= 0) { i++; break; }
  }
  return { html: buf.join('\n'), next: i };
}

// GitHub-style pipe-table helpers.
function isTableSep(line) {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line || '');
}
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
}
function alignOf(cell) {
  const l = cell.startsWith(':'), r = cell.endsWith(':');
  return (l && r) ? 'center' : r ? 'right' : l ? 'left' : '';
}

// Inline formatting. Lets safe inline HTML (e.g. <mark>, <a>, <img>) through and
// adds **bold**, *italic*, `code`, [links](url), ![images](url) and ==highlight==.
function inlineMd(s) {
  s = softEscape(s);
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (m, a, u) => '<img src="' + u + '" alt="' + a + '" loading="lazy">');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => '<a href="' + u + '" rel="noopener" target="_blank">' + t + '</a>');
  s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function renderMarkdownServer(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let html = '', i = 0, para = [];
  const flush = () => { if (para.length) { html += '<p>' + para.map(inlineMd).join('<br>') + '</p>\n'; para = []; } };
  while (i < lines.length) {
    const line = lines[i], t = line.trim();

    if (t === '') { flush(); i++; continue; }

    // Raw HTML block (pasted table, highlight/callout box, figure...) — pass through.
    if (BLOCK_HTML_RE.test(t)) {
      flush();
      const cap = captureHtmlBlock(lines, i);
      html += sanitizeHtml(cap.html) + '\n';
      i = cap.next; continue;
    }

    // Markdown pipe table: a header row immediately followed by a |---|---| line.
    if (t.includes('|') && isTableSep(lines[i + 1])) {
      flush();
      const headers = splitRow(lines[i]);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      let body = '';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = splitRow(lines[i]);
        body += '<tr>' + cells.map((c, x) => '<td' + (aligns[x] ? ' style="text-align:' + aligns[x] + '"' : '') + '>' + inlineMd(c) + '</td>').join('') + '</tr>\n';
        i++;
      }
      html += '<div class="table-wrap"><table><thead><tr>'
        + headers.map((c, x) => '<th' + (aligns[x] ? ' style="text-align:' + aligns[x] + '"' : '') + '>' + inlineMd(c) + '</th>').join('')
        + '</tr></thead><tbody>\n' + body + '</tbody></table></div>\n';
      continue;
    }

    // Horizontal rule (--- *** ___).
    if (/^([-*_])\1{2,}$/.test(t)) { flush(); html += '<hr>\n'; i++; continue; }

    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const l = h[1].length; html += '<h' + l + '>' + inlineMd(h[2]) + '</h' + l + '>\n'; i++; continue; }
    if (/^>\s?/.test(t)) { flush(); html += '<blockquote>' + inlineMd(t.replace(/^>\s?/, '')) + '</blockquote>\n'; i++; continue; }
    if (/^[-*]\s+/.test(t)) { flush(); html += '<ul>\n'; while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) { html += '<li>' + inlineMd(lines[i].trim().replace(/^[-*]\s+/, '')) + '</li>\n'; i++; } html += '</ul>\n'; continue; }
    if (/^\d+\.\s+/.test(t)) { flush(); html += '<ol>\n'; while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) { html += '<li>' + inlineMd(lines[i].trim().replace(/^\d+\.\s+/, '')) + '</li>\n'; i++; } html += '</ol>\n'; continue; }

    para.push(line); i++;
  }
  flush();
  return html;
}

// CSS injected into every server-rendered page's <head>. Because React only
// replaces #root (never <head>), these styles also apply once the live app
// takes over — so pasted tables and highlights look right everywhere.
const ARTICLE_EXTRA_CSS =
  '.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:24px 0}'
  + '.article-body table,.article-detail table,.table-wrap table{border-collapse:collapse;width:100%;font-size:.95rem;background:#fff;border:1px solid #e3e3e8;border-radius:10px;overflow:hidden}'
  + '.article-body th,.article-body td,.article-detail th,.article-detail td,.table-wrap th,.table-wrap td{padding:11px 14px;border-bottom:1px solid #ececf1;text-align:left;vertical-align:top}'
  + '.article-body thead th,.article-detail thead th,.table-wrap thead th{background:#1f2430;color:#fff;font-weight:600;border-bottom:none}'
  + '.article-body tbody tr:nth-child(even),.article-detail tbody tr:nth-child(even),.table-wrap tbody tr:nth-child(even){background:#fafafc}'
  + '.article-body tbody tr:last-child td,.article-detail tbody tr:last-child td,.table-wrap tbody tr:last-child td{border-bottom:none}'
  + 'mark{background:#fff3b0;color:inherit;padding:.05em .3em;border-radius:3px}'
  + '.callout,.note,.tip,.info,.warning{margin:24px 0;padding:16px 18px;border-radius:10px;border-left:4px solid #6c5ce7;background:#f4f2ff;line-height:1.6}'
  + '.callout p:last-child,.note p:last-child,.tip p:last-child,.info p:last-child,.warning p:last-child{margin-bottom:0}'
  + '.tip{border-left-color:#00b894;background:#eafaf4}'
  + '.warning{border-left-color:#e17055;background:#fdeee9}'
  + '.info{border-left-color:#0984e3;background:#e9f3fd}';

function isRealImage(src) { return src && !src.startsWith('data:'); }
function dateOnly(d) { try { return new Date(d).toISOString().slice(0, 10); } catch { return ''; } }

// A lightweight static header + footer with REAL links, so crawlers can follow
// internal links and no-JS visitors can still navigate.
function staticChrome(inner) {
  return '<header><div class="container"><div class="header-content">'
    + '<a class="logo" href="/" style="text-decoration:none;color:inherit">\u{1F3AE} glitchory</a>'
    + '<nav><a href="/">Home</a><a href="/news">News</a></nav>'
    + '</div></div></header>'
    + inner
    + '<footer><div class="container">'
    + '<div style="display:flex;gap:20px;justify-content:center;margin-bottom:12px;flex-wrap:wrap">'
    + '<a style="color:#bbb" href="/about">About</a>'
    + '<a style="color:#bbb" href="/contact">Contact</a>'
    + '<a style="color:#bbb" href="/privacy">Privacy Policy</a>'
    + '</div><p>&copy; 2026 glitchory. All rights reserved.</p></div></footer>';
}

// Article card as a real <a href> link (crawlable + works without JS).
function cardHtml(a) {
  const img = isRealImage(a.featured_image)
    ? '<img src="' + escapeHtml(a.featured_image) + '" class="article-image" alt="' + escapeHtml(a.title) + '">' : '';
  return '<a class="article-card" href="/article/' + escapeHtml(a.slug) + '" style="display:block;text-decoration:none;color:inherit">'
    + img
    + '<div class="article-content">'
    + '<div class="article-meta"><span class="article-category">' + escapeHtml(a.category || '') + '</span><span>' + dateOnly(a.created_at) + '</span></div>'
    + '<h3>' + escapeHtml(a.title) + '</h3>'
    + '<p>' + escapeHtml(a.excerpt || '') + '</p>'
    + '<span class="read-more">Read More \u2192</span>'
    + '</div></a>';
}

// Full server-rendered article page body.
function articleSeoHtml(a) {
  const img = isRealImage(a.featured_image)
    ? '<img src="' + escapeHtml(a.featured_image) + '" class="feat" alt="' + escapeHtml(a.title) + '">' : '';
  return '<main><div class="container"><div class="article-detail">'
    + '<a class="back-link" href="/news">\u2190 Back to News</a>'
    + '<h1>' + escapeHtml(a.title) + '</h1>'
    + '<div class="meta"><span>' + escapeHtml(a.category || '') + '</span><span>' + dateOnly(a.created_at) + '</span></div>'
    + img
    + '<div class="article-body">' + renderMarkdownServer(a.content) + '</div>'
    + '</div></div></main>';
}

// Server-rendered list page (home / news).
function listSeoHtml(articles, heading, intro) {
  return '<main><div class="container">'
    + (intro ? '<div class="hero"><h1>glitchory</h1><p>' + escapeHtml(intro) + '</p></div>' : '')
    + '<h2 style="margin-bottom:24px">' + escapeHtml(heading) + '</h2>'
    + (articles.length ? '<div class="articles-grid">' + articles.map(cardHtml).join('\n') + '</div>'
                       : '<p>No articles published yet.</p>')
    + '</div></main>';
}

// Server-rendered simple text page (about / contact / privacy).
function staticPageSeoHtml(title, body) {
  return '<main><div class="container"><div class="article-detail">'
    + '<a class="back-link" href="/">\u2190 Back to Home</a>'
    + '<h1>' + escapeHtml(title) + '</h1>'
    + '<div class="article-body">' + renderMarkdownServer(body) + '</div>'
    + '</div></div></main>';
}

// Build a <head> block (title + description + canonical + Open Graph + Twitter).
function buildHead({ title, desc, canonical, image, type, extra }) {
  let h = '<title>' + escapeHtml(title) + '</title>';
  h += '\n  <meta name="description" content="' + escapeHtml(desc) + '">';
  if (canonical) h += '\n  <link rel="canonical" href="' + escapeHtml(canonical) + '">';
  h += '\n  <meta property="og:type" content="' + (type || 'website') + '">';
  h += '\n  <meta property="og:site_name" content="glitchory">';
  h += '\n  <meta property="og:title" content="' + escapeHtml(title) + '">';
  h += '\n  <meta property="og:description" content="' + escapeHtml(desc) + '">';
  if (canonical) h += '\n  <meta property="og:url" content="' + escapeHtml(canonical) + '">';
  if (image) h += '\n  <meta property="og:image" content="' + escapeHtml(image) + '">';
  h += '\n  <meta name="twitter:card" content="' + (image ? 'summary_large_image' : 'summary') + '">';
  if (extra) h += '\n  ' + extra;
  h += '\n  <style>' + ARTICLE_EXTRA_CSS + '</style>';
  return h;
}

function jsonLd(obj) {
  return '<script type="application/ld+json">' + JSON.stringify(obj).replace(/</g, '\\u003c') + '</script>';
}

// Swap the shell's default <title> + description for page-specific ones,
// and inject server-rendered content into #root.
function applyHead(html, headHtml) {
  return html
    .replace(/<title>[\s\S]*?<\/title>/, headHtml)
    .replace(/<meta name="description"[^>]*>/, '');
}
function injectRoot(html, inner) {
  return html.replace('<div id="root"></div>', '<div id="root">' + inner + '</div>');
}

// Static page copy (kept in sync with the React components in index.html).
const ABOUT_TEXT = `glitchory is an independent publication covering technology and gaming. We share news, hands-on impressions, and practical reviews aimed at helping readers stay informed about the products and trends shaping both industries.

Our coverage spans consumer tech, hardware, software, and the games people are playing right now. Every article is written and edited by our small team, and we focus on clear, useful writing over hype.

If you'd like to get in touch about a story, a correction, or a partnership, head to our Contact page.`;

const CONTACT_TEXT = `We'd love to hear from you.

For general enquiries, story tips, corrections, or advertising questions, email us at: hello@glitchory.com

We read every message and aim to reply within a few business days.`;

const PRIVACY_TEXT = `Last updated: 2026

This Privacy Policy explains how glitchory ("we", "us") handles information when you visit our website.

## Information we collect
We do not require you to create an account or submit personal information to read our content. We may collect standard, non-identifying technical data such as browser type, device, and pages visited, through analytics and advertising tools.

## Cookies
Our site uses cookies and similar technologies to understand how visitors use the site and to display advertising.

## Advertising and third parties
We use Google AdSense to display ads. Third-party vendors, including Google, use cookies to serve ads based on a user's prior visits to this and other websites. You may opt out of personalised advertising by visiting Google's Ads Settings.

## Children's privacy
This site is not directed at children under 13, and we do not knowingly collect personal information from them.

## Contact
Questions about this policy can be sent to hello@glitchory.com.`;

// Produce a clean, unique slug (e.g. "the-new-gpu", then "-2", "-3" only on collision)
async function uniqueSlug(base, excludeId) {
  let root = slugify(base) || 'post';
  let candidate = root, n = 2;
  while (true) {
    const existing = await articlesCol.findOne({ slug: candidate });
    if (!existing || existing.id === excludeId) return candidate;
    candidate = root + '-' + n; n++;
  }
}

// ---------- Related-article recommendation ----------
const STOPWORDS = new Set(('the a an and or but of to in on for with is are was were be been this that it its as at by from how what why when ' +
  'your you we our us they them he she his her their i my me will would can could should has have had do does did not no yes new best top ' +
  'about into over under out up down off than then them too very just more most some any all also got get one two three').split(' '));

function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// Weighted bag of words for an article (title and keywords matter most)
function articleTokens(a) {
  const w = {};
  const add = (text, weight) => { for (const t of tokenize(text)) w[t] = (w[t] || 0) + weight; };
  add(a.title, 3);
  add(a.keywords, 3);
  add(a.excerpt, 1);
  return w;
}

// Similarity score between two articles
function similarity(current, ct, other) {
  let s = 0;
  if (current.category && current.category === other.category) s += 4;  // same category = strong signal
  const ot = articleTokens(other);
  for (const t in ct) if (ot[t]) s += Math.min(ct[t], ot[t]);           // shared weighted words
  return s;
}

async function connectDB() {
  if (!MONGODB_URI) {
    console.log('');
    console.log('  ⚠  No MONGODB_URI set. The site will run, but');
    console.log('     saving/reading posts needs the database.');
    console.log('     Set MONGODB_URI to your Atlas connection string.');
    console.log('');
    return;
  }
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  await client.db(DB_NAME).command({ ping: 1 });   // confirm the connection actually works
  db = client.db(DB_NAME);
  articlesCol = db.collection('articles');
  commentsCol = db.collection('comments');
  metaCol = db.collection('meta');

  // Seed the id counter if missing
  const counter = await metaCol.findOne({ _id: 'counter' });
  if (!counter) await metaCol.insertOne({ _id: 'counter', nextId: 1 });

  // Seed settings if missing
  const settings = await metaCol.findOne({ _id: 'settings' });
  if (!settings) {
    await metaCol.insertOne({ _id: 'settings', adsenseId: '', siteName: 'glitchory', siteDescription: '' });
  }
  console.log('  ✓ Connected to MongoDB');
}

// Tries to connect if not already connected. Safe to call on every request:
// once Atlas lets us in, the next request reconnects automatically (no redeploy needed).
let connecting = null;
async function ensureDB() {
  if (articlesCol) return true;
  if (!MONGODB_URI) return false;
  if (!connecting) {
    connecting = connectDB()
      .catch(e => { console.log('  ✗ DB connection error:', e.message); articlesCol = null; })
      .finally(() => { connecting = null; });
  }
  await connecting;
  return !!articlesCol;
}

async function nextId() {
  const r = await metaCol.findOneAndUpdate(
    { _id: 'counter' },
    { $inc: { nextId: 1 } },
    { returnDocument: 'before', upsert: true }
  );
  return (r && r.nextId) ? r.nextId : 1;
}

async function dbReady(res) {
  if (await ensureDB()) return true;
  res.status(503).json({ error: 'Database not connected yet. If you just fixed Network Access in Atlas, wait a moment and try again.' });
  return false;
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

function requireAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Wrong admin key' });
  }
  next();
}

// ---------- PUBLIC API ----------

app.get('/api/categories', (req, res) => {
  res.json(DEFAULT_CATEGORIES);
});

app.get('/api/articles', async (req, res) => {
  if (!(await dbReady(res))) return;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const category = req.query.category;

  const query = { published: true };
  if (category && category !== 'all') query.category = category;

  const total = await articlesCol.countDocuments(query);
  const articles = await articlesCol.find(query)
    .sort({ created_at: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  res.json({ articles, total, pages: Math.max(1, Math.ceil(total / limit)), currentPage: page });
});

app.get('/api/articles/:slug', async (req, res) => {
  if (!(await dbReady(res))) return;
  const article = await articlesCol.findOne({ slug: req.params.slug, published: true });
  if (!article) return res.status(404).json({ error: 'Not found' });
  await articlesCol.updateOne({ id: article.id }, { $inc: { views: 1 } });
  article.views = (article.views || 0) + 1;
  res.json(article);
});

// Public config the frontend needs (Google client ID is public by design)
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// ---------- COMMENTS ----------

app.get('/api/articles/:slug/related', async (req, res) => {
  if (!(await dbReady(res))) return;
  const limit = Math.min(parseInt(req.query.limit) || 3, 8);
  const current = await articlesCol.findOne({ slug: req.params.slug, published: true });
  if (!current) return res.json([]);

  const others = (await articlesCol.find({ published: true }).toArray()).filter(a => a.id !== current.id);
  const ct = articleTokens(current);
  const scored = others.map(a => ({ a, s: similarity(current, ct, a) }));
  // Best matches first; ties (or all-zero) fall back to newest
  scored.sort((x, y) => y.s - x.s || new Date(y.a.created_at) - new Date(x.a.created_at));

  const top = scored.slice(0, limit).map(({ a }) => ({
    id: a.id, title: a.title, slug: a.slug, excerpt: a.excerpt,
    category: a.category, featured_image: a.featured_image, created_at: a.created_at
  }));
  res.json(top);
});

app.get('/api/articles/:slug/comments', async (req, res) => {
  if (!(await dbReady(res))) return;
  const list = await commentsCol.find({ slug: req.params.slug }).sort({ created_at: -1 }).toArray();
  // Never expose the Google user id (sub) publicly
  res.json(list.map(c => ({ id: c.id, name: c.name, picture: c.picture, text: c.text, created_at: c.created_at })));
});

app.post('/api/articles/:slug/comments', async (req, res) => {
  if (!(await dbReady(res))) return;
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Comments are not set up yet (GOOGLE_CLIENT_ID missing).' });

  const { credential, text } = req.body;
  if (!credential) return res.status(401).json({ error: 'Please sign in with Google to comment.' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (text.length > 2000) return res.status(400).json({ error: 'Comment is too long (2000 char max).' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (e) {
    return res.status(401).json({ error: 'Your sign-in could not be verified. Please sign in again.' });
  }

  const id = await nextId();
  const comment = {
    id,
    slug: req.params.slug,
    name: payload.name || 'Anonymous',
    picture: payload.picture || '',
    sub: payload.sub,            // stored privately for moderation, never sent to public
    text: text.trim(),
    created_at: new Date().toISOString()
  };
  await commentsCol.insertOne(comment);
  res.json({ id: comment.id, name: comment.name, picture: comment.picture, text: comment.text, created_at: comment.created_at });
});

app.delete('/admin/comments/:id', requireAuth, async (req, res) => {
  if (!(await dbReady(res))) return;
  await commentsCol.deleteOne({ id: parseInt(req.params.id) });
  res.json({ message: 'Comment deleted' });
});

// ---------- ADMIN API ----------

app.get('/admin/articles', requireAuth, async (req, res) => {
  if (!(await dbReady(res))) return;
  const articles = await articlesCol.find({}).sort({ created_at: -1 }).toArray();
  res.json(articles);
});

app.post('/admin/articles', requireAuth, async (req, res) => {
  if (!(await dbReady(res))) return;
  const { title, content, excerpt, category, featured_image, published, meta_description, keywords, slug } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });

  const id = await nextId();
  const article = {
    id,
    title,
    slug: await uniqueSlug(slug || title, id),
    content,
    excerpt: excerpt || '',
    meta_description: meta_description || '',
    keywords: keywords || '',
    category: category || 'tech-news',
    featured_image: featured_image || '',
    author: 'Admin',
    published: !!published,
    views: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await articlesCol.insertOne(article);
  res.json({ message: 'Article created', id, slug: article.slug });
});

app.put('/admin/articles/:id', requireAuth, async (req, res) => {
  if (!(await dbReady(res))) return;
  const id = parseInt(req.params.id);
  const existing = await articlesCol.findOne({ id });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { title, content, excerpt, category, featured_image, published, meta_description, keywords, slug } = req.body;
  // Keep the slug stable by default (good for SEO). Only change it if the user typed a new custom slug.
  let newSlug = existing.slug;
  if (slug && slugify(slug) !== existing.slug) newSlug = await uniqueSlug(slug, id);

  const update = {
    title: title ?? existing.title,
    slug: newSlug,
    content: content ?? existing.content,
    excerpt: excerpt ?? existing.excerpt,
    meta_description: meta_description ?? existing.meta_description ?? '',
    keywords: keywords ?? existing.keywords ?? '',
    category: category ?? existing.category,
    featured_image: featured_image ?? existing.featured_image,
    published: !!published,
    updated_at: new Date().toISOString()
  };
  await articlesCol.updateOne({ id }, { $set: update });
  res.json({ message: 'Article updated', slug: newSlug });
});

app.delete('/admin/articles/:id', requireAuth, async (req, res) => {
  if (!(await dbReady(res))) return;
  await articlesCol.deleteOne({ id: parseInt(req.params.id) });
  res.json({ message: 'Article deleted' });
});

app.get('/admin/settings', requireAuth, async (req, res) => {
  if (!(await dbReady(res))) return;
  const s = await metaCol.findOne({ _id: 'settings' });
  res.json({ adsenseId: s?.adsenseId || '', siteName: s?.siteName || 'glitchory', siteDescription: s?.siteDescription || '' });
});

app.post('/admin/settings', requireAuth, async (req, res) => {
  if (!(await dbReady(res))) return;
  const { adsenseId, siteName, siteDescription } = req.body;
  await metaCol.updateOne({ _id: 'settings' }, { $set: { adsenseId, siteName, siteDescription } }, { upsert: true });
  res.json({ message: 'Settings saved' });
});

// ---------- FRONTEND ----------

app.get('/health', (req, res) => res.json({ status: 'ok', db: !!articlesCol }));

// ads.txt tells ad networks you authorize Google to sell ads on your domain
app.get('/ads.txt', (req, res) => {
  res.type('text/plain').send('google.com, pub-2286202749889925, DIRECT, f08c47fec0942fa0\n');
});

// robots.txt — points crawlers to the sitemap
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: ' + SITE_URL + '/sitemap.xml\n');
});

// sitemap.xml — lists every page so Google can discover and index them
app.get('/sitemap.xml', async (req, res) => {
  const entries = [
    { loc: SITE_URL + '/' }, { loc: SITE_URL + '/news' },
    { loc: SITE_URL + '/about' }, { loc: SITE_URL + '/contact' }, { loc: SITE_URL + '/privacy' }
  ];
  if (await ensureDB()) {
    const arts = await articlesCol.find({ published: true }).sort({ created_at: -1 }).toArray();
    for (const a of arts) entries.push({ loc: SITE_URL + '/article/' + a.slug, lastmod: dateOnly(a.updated_at || a.created_at) });
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.map(e => '  <url><loc>' + escapeHtml(e.loc) + '</loc>' + (e.lastmod ? '<lastmod>' + e.lastmod + '</lastmod>' : '') + '</url>').join('\n') +
    '\n</urlset>\n';
  res.type('application/xml').send(xml);
});

// Read the HTML shell once and cache it
let htmlShell = null;
function getHtmlShell() {
  if (!htmlShell) htmlShell = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  return htmlShell;
}

// Homepage: server-render the latest stories so crawlers see real content + links.
app.get('/', async (req, res) => {
  let html = getHtmlShell();
  try {
    const head = buildHead({
      title: 'glitchory \u2014 Tech & Gaming News, Reviews and Guides',
      desc: 'glitchory covers the latest technology and gaming news, hands-on reviews, and practical guides.',
      canonical: SITE_URL + '/',
      extra: jsonLd({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'glitchory', url: SITE_URL,
        description: 'Tech and gaming news, reviews and guides.' })
    });
    html = applyHead(html, head);
    if (await ensureDB()) {
      const arts = await articlesCol.find({ published: true }).sort({ created_at: -1 }).limit(6).toArray();
      html = injectRoot(html, staticChrome(listSeoHtml(arts, 'Latest Stories', 'The latest in technology and gaming')));
    }
  } catch (e) { /* fall back to plain shell */ }
  res.type('html').send(html);
});

// News listing: server-render all published articles.
app.get('/news', async (req, res) => {
  let html = getHtmlShell();
  try {
    html = applyHead(html, buildHead({
      title: 'News \u2014 glitchory',
      desc: 'All the latest technology and gaming news from glitchory.',
      canonical: SITE_URL + '/news'
    }));
    if (await ensureDB()) {
      const arts = await articlesCol.find({ published: true }).sort({ created_at: -1 }).limit(50).toArray();
      html = injectRoot(html, staticChrome(listSeoHtml(arts, 'Latest News', '')));
    }
  } catch (e) { /* fall back to plain shell */ }
  res.type('html').send(html);
});

// Static pages: server-render their text so they aren't empty for crawlers / AdSense review.
function serveStatic(res, pathName, title, desc, body) {
  let html = getHtmlShell();
  html = applyHead(html, buildHead({ title: title + ' \u2014 glitchory', desc, canonical: SITE_URL + pathName }));
  html = injectRoot(html, staticChrome(staticPageSeoHtml(title, body)));
  res.type('html').send(html);
}
app.get('/about',   (req, res) => serveStatic(res, '/about',   'About glitchory', 'About glitchory \u2014 an independent tech and gaming publication.', ABOUT_TEXT));
app.get('/contact', (req, res) => serveStatic(res, '/contact', 'Contact Us',      'Contact glitchory with story tips, corrections, or advertising enquiries.', CONTACT_TEXT));
app.get('/privacy', (req, res) => serveStatic(res, '/privacy', 'Privacy Policy',  'How glitchory handles your information, cookies, and advertising.', PRIVACY_TEXT));

// Article pages: inject full title + meta + social tags + Article structured data,
// AND the real article body, so Google/AdSense see complete content without running JS.
app.get('/article/:slug', async (req, res) => {
  let html = getHtmlShell();
  try {
    if (await ensureDB()) {
      const a = await articlesCol.findOne({ slug: req.params.slug, published: true });
      if (a) {
        const desc = (a.meta_description || a.excerpt || a.title).slice(0, 300);
        const url = SITE_URL + '/article/' + a.slug;
        const ogImage = isRealImage(a.featured_image) ? a.featured_image : '';
        let extra = '';
        if (a.keywords) extra += '<meta name="keywords" content="' + escapeHtml(a.keywords) + '">\n  ';
        extra += jsonLd({
          '@context': 'https://schema.org', '@type': 'Article',
          headline: a.title, description: desc,
          datePublished: a.created_at, dateModified: a.updated_at || a.created_at,
          author: { '@type': 'Organization', name: 'glitchory' },
          publisher: { '@type': 'Organization', name: 'glitchory' },
          mainEntityOfPage: url, ...(ogImage ? { image: ogImage } : {})
        });
        html = applyHead(html, buildHead({
          title: a.title + ' | glitchory', desc, canonical: url,
          image: ogImage, type: 'article', extra
        }));
        html = injectRoot(html, staticChrome(articleSeoHtml(a)));
      }
    }
  } catch (e) { /* fall back to the plain shell */ }
  res.type('html').send(html);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Start listening IMMEDIATELY so the site always responds (no 502 while DB connects)
app.listen(PORT, () => {
  console.log('========================================');
  console.log('  glitchory is running on port ' + PORT);
  console.log('  Admin key: ' + ADMIN_KEY);
  console.log('========================================');
});

// Connect to the database in the background; routes return a clear
// "Database not connected" message until this succeeds.
connectDB().catch(e => console.log('  ✗ DB connection error:', e.message));
