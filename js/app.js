/* =========================================================
   Supabase client
   ========================================================= */
const SUPABASE_URL = 'https://vppyvfrjcrvcngzvddzi.supabase.co'; // ← your Project URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwcHl2ZnJqY3J2Y25nenZkZHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyNTI5NTAsImV4cCI6MjEwNDgyODk1MH0.axx-_U8o7JZEGit5lda0PllZY2kgTB4-nPTe124vXw0'; // ← your anon key

const supabaseLib = window.supabase || (typeof supabase !== 'undefined' ? supabase : null);

if (!supabaseLib || typeof supabaseLib.createClient !== 'function') {
  console.error('Supabase SDK failed to load. Check the CDN script tag.');
}

const supabase = supabaseLib ?
  supabaseLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) :
  null;

/* =========================================================
   Store — same API as before, backed by Supabase
   Messages are per (userId, link) thread.
   Session still lives in localStorage.
   ========================================================= */
const Store = {
  async getUsers() {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) {
      console.error('getUsers', error);
      return [];
    }
    return (data || []).map(rowToUser);
  },

  async saveUsers() {
    /* no-op — kept for compatibility, prefer upsertProfile */
  },

  async getMessages(userId, link) {
    const key = link || 'default';
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('thread_user_id', userId)
      .eq('link', key)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('getMessages', error);
      return [];
    }
    return (data || []).map(function (m) {
      return {
        id: m.id,
        senderId: m.sender_id,
        receiverId: m.receiver_id,
        body: m.body,
        ts: new Date(m.created_at).getTime()
      };
    });
  },

  async saveMessage(userId, link, msg) {
    const key = link || 'default';
    const { error } = await supabase.from('messages').insert({
      id: msg.id,
      thread_user_id: userId,
      link: key,
      sender_id: msg.senderId,
      receiver_id: msg.receiverId,
      body: msg.body,
      created_at: new Date(msg.ts || Date.now()).toISOString()
    });
    if (error) console.error('saveMessage', error);
  },

  // { linkSlug: [msg, ...], ... }
  async getUserThreads(userId) {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('thread_user_id', userId)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('getUserThreads', error);
      return {};
    }
    const threads = {};
    (data || []).forEach(function (m) {
      const link = m.link || 'default';
      if (!threads[link]) threads[link] = [];
      threads[link].push({
        id: m.id,
        senderId: m.sender_id,
        receiverId: m.receiver_id,
        body: m.body,
        ts: new Date(m.created_at).getTime()
      });
    });
    return threads;
  },

  getSession() {
    try { return JSON.parse(localStorage.getItem('ss_session') || 'null'); }
    catch { return null; }
  },
  setSession(user) {
    localStorage.setItem('ss_session', JSON.stringify(user));
  },
  clearSession() {
    localStorage.removeItem('ss_session');
  },

  async getReads() {
    const { data, error } = await supabase.from('admin_reads').select('*');
    if (error) {
      console.error('getReads', error);
      return {};
    }
    const map = {};
    (data || []).forEach(function (r) {
      map[threadKey(r.user_id, r.link)] = new Date(r.read_at).getTime();
    });
    return map;
  },

  async markRead(userId, link) {
    const key = link || 'default';
    const { error } = await supabase.from('admin_reads').upsert({
      user_id: userId,
      link: key,
      read_at: new Date().toISOString()
    });
    if (error) console.error('markRead', error);
  }
};

function threadKey(userId, link) {
  return String(userId) + '::' + String(link || 'default');
}

function rowToUser(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email || '',
    whatsapp: r.whatsapp || '',
    isAdmin: !!r.is_admin,
    site: r.site || null,
    siteName: r.site_name || null
  };
}

async function upsertProfile(user) {
  const { error } = await supabase.from('profiles').upsert({
    id: user.id,
    name: user.name,
    email: user.email || '',
    whatsapp: user.whatsapp || '',
    is_admin: !!user.isAdmin,
    site: user.site || null,
    site_name: user.siteName || null
  });
  if (error) console.error('upsertProfile', error);
}

/* =========================================================
   Admin access
   ========================================================= */
const ADMIN_EMAIL = 'admin@support.com';

/* =========================================================
   Email validation
   ========================================================= */
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

function isValidEmail(str) {
  const value = String(str || '').trim();
  if (!value || value.length > 254) return false;
  if (value.includes('..')) return false;
  return EMAIL_RE.test(value);
}

/* =========================================================
   Multi-site branding — site vs. link
   ========================================================= */
const SITE_OVERRIDES = {
  // 'acme': { name: 'Acme Care', color: '#6e8bff' }
};

function slugToName(slug) {
  return String(slug)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase()) || 'Support';
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = str.charCodeAt(i) + ((h << 5) - h);
  }
  return Math.abs(h) % 360;
}

function siteColor(slug) {
  if (SITE_OVERRIDES[slug] && SITE_OVERRIDES[slug].color) {
    return SITE_OVERRIDES[slug].color;
  }
  const hue = hashHue(slug);
  return 'hsl(' + hue + ', 72%, 64%)';
}

// The raw `site`/`brand` URL param only — null if this page load
// didn't carry one.
function explicitSiteParam() {
  const params = new URLSearchParams(window.location.search);
  return params.get('site') || params.get('brand') || null;
}

// Pulls a short label out of document.referrer — e.g. "ourgroup"
// from "https://ourgroup.com/contact" or "https://www.ourgroup.co.uk/".
// Only returns something when the referrer is a DIFFERENT origin than
// this app itself: navigating between this app's own pages (login →
// signup → chat) must never be mistaken for a new embedding site.
function getReferrerSlug() {
  try {
    if (!document.referrer) return null;
    const ref = new URL(document.referrer);
    if (ref.hostname === window.location.hostname) return null;
    const host = ref.hostname.replace(/^www\./, '');
    const label = host.split('.')[0];
    return label ? label.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Whatever THIS specific page load's URL/referrer explicitly tells us
// about the site — an explicit ?site= param, or (failing that) a
// cross-origin referrer. Returns null when this load carries no such
// signal at all, meaning "trust whatever's already active" instead.
function contextSiteSlug() {
  return explicitSiteParam() || getReferrerSlug();
}

// The website — the account boundary. A fresh signal (URL param or a
// new external referrer) always wins, since it's the most current
// truth about where this visit came from; only when neither is
// present does this fall back to the existing session/localStorage,
// so a bookmarked or reloaded page keeps working without one.
function getSiteSlug() {
  const context = contextSiteSlug();
  if (context) {
    localStorage.setItem('ss_last_site', context);
    return context;
  }
  const session = Store.getSession();
  if (session && session.site) return session.site;
  return localStorage.getItem('ss_last_site') || 'support';
}

// The specific link (help / info / support / ...) — display only.
// On a fresh site context (a param or a new referrer) with no link
// override, the link IS that site — never a stale link left over
// from browsing a different embedded site earlier in this browser.
function getLinkSlug() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('link') || params.get('entry');
  if (fromUrl) {
    localStorage.setItem('ss_last_link', fromUrl);
    return fromUrl;
  }
  const context = contextSiteSlug();
  if (context) {
    localStorage.setItem('ss_last_link', context);
    return context;
  }
  return localStorage.getItem('ss_last_link') || getSiteSlug();
}

function siteDisplayName(slug) {
  if (SITE_OVERRIDES[slug] && SITE_OVERRIDES[slug].name) return SITE_OVERRIDES[slug].name;
  return slugToName(slug);
}

// What's shown as the brand name/logo on screen.
// - A distinct link (e.g. ?site=acme&link=help) shows that link's
//   own name — "Help" — as before.
// - No distinct link (the common case: a single "Contact Us" button,
//   whether it's a bare embed picked up via referrer, or an explicit
//   ?site=acme with no ?link=) shows "<site>@support" — so every
//   website you embed this on reads as its own distinct handle
//   without you ever having to edit the embed code.
// - True bare default (no param, no referrer, nothing stored — e.g.
//   opening the app directly) shows plain "Support".
function getBrand() {
  const site = getSiteSlug();
  const link = getLinkSlug();
  if (link !== site) {
    return siteDisplayName(link);
  }
  if (site === 'support') {
    return 'Support';
  }
  return site + '@support';
}

function applyBrandTheme() {}

/* =========================================================
   Auth helpers — passwordless, site-scoped
   ========================================================= */
function requireAuth(adminOnly) {
  const session = Store.getSession();
  if (!session) {
    window.location.href = 'index.html' + window.location.search;
    return null;
  }

  // A fresh site signal (param or a new external referrer) that
  // disagrees with the signed-in account's site means this visit
  // belongs to a different website — that session doesn't apply here.
  const context = contextSiteSlug();
  if (!session.isAdmin && context && session.site !== context) {
    Store.clearSession();
    window.location.href = 'index.html' + window.location.search;
    return null;
  }

  if (adminOnly && !session.isAdmin) {
    window.location.href = 'chat.html';
    return null;
  }
  if (!adminOnly && session.isAdmin) {
    window.location.href = 'admin.html';
    return null;
  }
  return session;
}

function normalizePhone(str) {
  return String(str || '').replace(/[^\d+]/g, '');
}

async function findUser(login) {
  const raw = String(login || '').trim();
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  const digits = normalizePhone(raw);
  const siteSlug = getSiteSlug();

  const users = await Store.getUsers();
  return users.find(function (u) {
    const email = String(u.email || '').trim().toLowerCase();
    const whatsapp = normalizePhone(u.whatsapp);
    const name = String(u.name || '').trim().toLowerCase();
    const matchesContact =
      (email && email === key) ||
      (digits && whatsapp && whatsapp === digits) ||
      (name && name === key);
    if (!matchesContact) return false;
    return u.isAdmin || u.site === siteSlug;
  });
}

function primaryContact(u) {
  return [u.email, u.whatsapp].filter(Boolean).join(' · ');
}

/* =========================================================
   Formatting / DOM helpers
   ========================================================= */
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRelativeDay(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return formatTime(ts);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .map(function (w) { return w[0] || ''; })
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// opts.groupedTop — true if the previous message was the same sender
//                   on the same day: tighter spacing, reads as one group.
// opts.hideTime   — true if the NEXT message is also the same sender
//                   on the same day: only the last bubble in a run
//                   shows a timestamp, instead of repeating it on
//                   every single line of a multi-message reply.
function createBubble(body, timeStr, isOut, opts) {
  opts = opts || {};
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (isOut ? 'out' : 'in') + (opts.groupedTop ? ' grouped' : '');

  const text = document.createElement('div');
  text.className = 'msg-text';
  text.textContent = body;
  wrap.appendChild(text);

  if (!opts.hideTime) {
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = timeStr;
    wrap.appendChild(time);
  }
  return wrap;
}

// Given a thread's messages in order, returns per-index grouping
// flags so both chat.html and admin-chat.html render identically
// grouped bubbles without duplicating this logic.
function messageGrouping(msgs) {
  return msgs.map(function (m, idx) {
    const day = new Date(m.ts).toDateString();
    const prev = msgs[idx - 1];
    const next = msgs[idx + 1];
    const groupedTop = !!(prev && prev.senderId === m.senderId &&
      new Date(prev.ts).toDateString() === day);
    const hideTime = !!(next && next.senderId === m.senderId &&
      new Date(next.ts).toDateString() === day);
    return { groupedTop: groupedTop, hideTime: hideTime };
  });
}

async function hasUnread(userId, link) {
  const msgs = await Store.getMessages(userId, link);
  if (!msgs.length) return false;
  const last = msgs[msgs.length - 1];
  if (last.senderId === userId) {
    const reads = await Store.getReads();
    const readAt = reads[threadKey(userId, link)] || 0;
    return last.ts > readAt;
  }
  return false;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}
