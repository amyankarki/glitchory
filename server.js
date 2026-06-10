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
  const urls = [SITE_URL + '/', SITE_URL + '/news', SITE_URL + '/about', SITE_URL + '/contact', SITE_URL + '/privacy'];
  if (await ensureDB()) {
    const arts = await articlesCol.find({ published: true }).sort({ created_at: -1 }).toArray();
    for (const a of arts) urls.push(SITE_URL + '/article/' + a.slug);
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => '  <url><loc>' + escapeHtml(u) + '</loc></url>').join('\n') +
    '\n</urlset>\n';
  res.type('application/xml').send(xml);
});

// Read the HTML shell once and cache it
let htmlShell = null;
function getHtmlShell() {
  if (!htmlShell) htmlShell = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  return htmlShell;
}

// Article pages: inject real title + meta description + keywords + social tags
// so Google and social scrapers see the right info even without running JS.
app.get('/article/:slug', async (req, res) => {
  let html = getHtmlShell();
  try {
    if (await ensureDB()) {
      const a = await articlesCol.findOne({ slug: req.params.slug, published: true });
      if (a) {
        const title = escapeHtml(a.title + ' | glitchory');
        const desc = escapeHtml((a.meta_description || a.excerpt || a.title).slice(0, 300));
        const url = SITE_URL + '/article/' + a.slug;
        const ogImage = (a.featured_image && !a.featured_image.startsWith('data:')) ? a.featured_image : '';
        let head = '<title>' + title + '</title>';
        head += '\n  <meta name="description" content="' + desc + '">';
        if (a.keywords) head += '\n  <meta name="keywords" content="' + escapeHtml(a.keywords) + '">';
        head += '\n  <link rel="canonical" href="' + escapeHtml(url) + '">';
        head += '\n  <meta property="og:type" content="article">';
        head += '\n  <meta property="og:title" content="' + escapeHtml(a.title) + '">';
        head += '\n  <meta property="og:description" content="' + desc + '">';
        head += '\n  <meta property="og:url" content="' + escapeHtml(url) + '">';
        if (ogImage) head += '\n  <meta property="og:image" content="' + escapeHtml(ogImage) + '">';
        head += '\n  <meta name="twitter:card" content="' + (ogImage ? 'summary_large_image' : 'summary') + '">';
        // Replace the default <title> and the default description with the article's
        html = html
          .replace(/<title>[\s\S]*?<\/title>/, head)
          .replace(/<meta name="description"[^>]*>/, '');
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
