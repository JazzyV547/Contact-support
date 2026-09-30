/* =========================================================
   Supabase client
   ========================================================= */
const SUPABASE_URL = 'https://vppyvfrjcrvcngzvddzi.supabase.co'; // ← your Project URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwcHl2ZnJqY3J2Y25nenZkZHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyNTI5NTAsImV4cCI6MjEwNDgyODk1MH0.axx-_U8o7JZEGit5lda0PllZY2kgTB4-nPTe124vXw0'; // ← your anon key

const supabaseLib = window.supabase;

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
    return (data || []).map(rowToMessage);
  },

  async saveMessage(userId, link, msg) {
    const key = link || 'default';
    const { error } = await supabase.from('messages').insert({
      id: msg.id,
      thread_user_id: userId,
      link: key,
      sender_id: msg.senderId,
      receiver_id: msg.receiverId,
      body: msg.body || '',
      attachment_url: msg.attachment ? msg.attachment.url : null,
      attachment_type: msg.attachment ? msg.attachment.type : null,
      attachment_name: msg.attachment ? (msg.attachment.name || null) : null,
      created_at: new Date(msg.ts || Date.now()).toISOString()
    });
    if (error) {
      console.error('saveMessage', error);
      return false;
    }
    return true;
  },

  // Uploads a photo/video to the chat-media bucket and returns
  // { url, type, name } to attach to a message.
  //
  // Uses XMLHttpRequest straight against the Storage REST endpoint
  // (instead of the SDK's fetch) for two reasons:
  //   1) fetch cannot report upload progress, so a slow connection
  //      looked exactly like "loading forever". XHR gives a real
  //      percentage via onProgress(0-100).
  //   2) A fixed 60s cap killed any big video on a slow network. Now
  //      the upload only fails if it makes NO progress for 45s, so a
  //      slow-but-moving upload is allowed to finish.
  // Rejects with a friendly Error on any failure.
  uploadAttachment(userId, link, file, onProgress) {
    const kind = attachmentKind(file);
    if (!kind) return Promise.reject(new Error('Only photos and videos can be sent.'));

    const safe = function (v) { return String(v || 'default').replace(/[^a-zA-Z0-9_-]/g, '_'); };
    const parts = String(file.name || '').split('.');
    let ext = parts.length > 1 ? parts.pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) : '';
    if (!ext) ext = kind === 'video' ? 'mp4' : 'jpg';

    const path = safe(userId) + '/' + safe(link) + '/' + Date.now() + '-' +
      Math.random().toString(36).slice(2, 8) + '.' + ext;

    const STALL_MS = 45000;

    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      let settled = false;
      let lastActivity = Date.now();

      function settle(fn, value) {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        fn(value);
      }

      const watchdog = setInterval(function () {
        if (Date.now() - lastActivity > STALL_MS) {
          settle(reject, new Error('Upload stalled — no data was sent for 45 seconds. Check your connection and try again (a shorter video may help).'));
          try { xhr.abort(); } catch (e) { /* ignore */ }
        }
      }, 3000);

      xhr.open('POST', SUPABASE_URL + '/storage/v1/object/' + MEDIA_BUCKET + '/' + path);
      xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
      xhr.setRequestHeader('Authorization', 'Bearer ' + SUPABASE_ANON_KEY);
      xhr.setRequestHeader('Content-Type', file.type || (kind === 'video' ? 'video/mp4' : 'image/jpeg'));
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.setRequestHeader('cache-control', 'max-age=31536000');

      xhr.upload.onprogress = function (e) {
        lastActivity = Date.now();
        if (e.lengthComputable && typeof onProgress === 'function') {
          onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
        }
      };

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          const pub = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path);
          settle(resolve, { url: pub.data.publicUrl, type: kind, name: file.name || null });
          return;
        }
        let detail = '';
        try {
          const j = JSON.parse(xhr.responseText);
          detail = j.message || j.error || '';
        } catch (e) { /* not JSON */ }
        console.error('uploadAttachment', xhr.status, xhr.responseText);
        if (xhr.status === 413) {
          settle(reject, new Error('That file is larger than the server allows.'));
        } else {
          settle(reject, new Error('Upload failed (' + xhr.status + ')' + (detail ? ': ' + detail : '. Check your connection and try again.')));
        }
      };

      xhr.onerror = function () {
        settle(reject, new Error('Upload failed. Check your connection and try again.'));
      };
      xhr.ontimeout = xhr.onerror;
      xhr.onabort = function () {
        settle(reject, new Error('Upload was cancelled.'));
      };

      xhr.send(file);
    });
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
      threads[link].push(rowToMessage(m));
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

function rowToMessage(m) {
  return {
    id: m.id,
    senderId: m.sender_id,
    receiverId: m.receiver_id,
    body: m.body || '',
    ts: new Date(m.created_at).getTime(),
    attachment: m.attachment_url ? {
      url: m.attachment_url,
      type: m.attachment_type === 'video' ? 'video' : 'image',
      name: m.attachment_name || null
    } : null
  };
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

function explicitSiteParam() {
  const params = new URLSearchParams(window.location.search);
  return params.get('site') || params.get('brand') || null;
}

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

function contextSiteSlug() {
  return explicitSiteParam() || getReferrerSlug();
}

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

function createBubble(body, timeStr, isOut, opts) {
  opts = opts || {};
  const att = opts.attachment || null;
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (isOut ? 'out' : 'in') +
    (opts.groupedTop ? ' grouped' : '') + (att ? ' has-media' : '');

  if (att) wrap.appendChild(buildMedia(att, opts.onMediaLoad));

  if (body) {
    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = body;
    wrap.appendChild(text);
  }

  if (!opts.hideTime) {
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = timeStr;
    wrap.appendChild(time);
  }
  return wrap;
}

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

/* =========================================================
   Photos & videos
   ========================================================= */
const MEDIA_BUCKET = 'chat-media';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

// Styles for the video tile are injected from here (not style.css) so
// they always ship together with this file and can never be left
// behind by a stale cached stylesheet.
(function injectMediaStyles() {
  if (document.getElementById('media-inline-styles')) return;
  const s = document.createElement('style');
  s.id = 'media-inline-styles';
  s.textContent =
    '.msg-media.is-video{display:block;position:relative;width:230px;max-width:100%;height:144px;' +
    'background:#15171a;background:linear-gradient(135deg,#1a1c20,#0a0a0c);cursor:pointer;}' +
    '.msg-media.is-video .media-play{position:absolute;top:0;left:0;right:0;bottom:0;margin:auto;' +
    'width:56px;height:56px;}' +
    '.msg-media.is-video .vid-label{position:absolute;left:10px;right:10px;bottom:8px;' +
    'font-size:0.72rem;line-height:1.3;color:rgba(255,255,255,0.75);' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;}' +
    '.msg-media.is-image{cursor:zoom-in;}';
  (document.head || document.documentElement).appendChild(s);
})();

function attachmentKind(file) {
  const t = String((file && file.type) || '');
  if (t.indexOf('image/') === 0) return 'image';
  if (t.indexOf('video/') === 0) return 'video';
  return null;
}

function formatBytes(n) {
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function validateAttachment(file) {
  const kind = attachmentKind(file);
  if (!kind) return 'Only photos and videos can be sent.';
  if (!file.size) return 'That file is empty.';
  if (kind === 'image' && file.size > MAX_IMAGE_BYTES) return 'That photo is too large (max 10 MB).';
  if (kind === 'video' && file.size > MAX_VIDEO_BYTES) return 'That video is too large (max 50 MB).';
  return null;
}

function messageSummary(m) {
  if (m.attachment) {
    const label = m.attachment.type === 'video' ? '🎥 Video' : '📷 Photo';
    return m.body ? label + ' · ' + m.body : label;
  }
  return m.body || '';
}

// Builds the media block inside a message bubble.
//  - Photos: the image itself; tap opens the full-screen viewer.
//  - Videos: a lightweight tile with a play icon (NO <video> element in
//    the bubble — mobile browsers render a broken, stretched default
//    placeholder for unloaded videos, which is what you were seeing).
//    Tap opens the full-screen player, which is the only place the
//    video file is actually loaded.
function buildMedia(att, onLoad) {
  const holder = document.createElement('div');
  holder.className = 'msg-media';
  holder.setAttribute('role', 'button');
  holder.setAttribute('tabindex', '0');

  function done() { if (typeof onLoad === 'function') onLoad(); }
  function open() { openMediaViewer(att.url, att.type, att.name); }

  holder.addEventListener('click', open);
  holder.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });

  if (att.type === 'video') {
    holder.className = 'msg-media is-video';
    holder.setAttribute('aria-label', 'Play video');

    const playBtn = document.createElement('div');
    playBtn.className = 'media-play';
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

    const label = document.createElement('div');
    label.className = 'vid-label';
    label.textContent = '🎥 ' + (att.name || 'Video');

    holder.appendChild(playBtn);
    holder.appendChild(label);
    setTimeout(done, 0);
  } else {
    holder.className = 'msg-media is-image';
    holder.setAttribute('aria-label', 'View photo');

    const img = document.createElement('img');
    img.alt = att.name || 'Photo';
    img.decoding = 'async';
    img.addEventListener('load', done);
    img.addEventListener('error', function () {
      holder.className = 'msg-media missing';
      holder.removeAttribute('role');
      holder.textContent = 'Media unavailable';
      done();
    });
    img.src = att.url;
    holder.appendChild(img);
  }
  return holder;
}

// Opens a full-screen photo/video viewer on top of everything.
// All positioning is INLINE so it works even if the stylesheet is
// stale or missing. Tap the dark area, press Esc, or tap × to close.
function openMediaViewer(url, type, alt) {
  if (document.querySelector('[data-media-viewer]')) return;

  const overlay = document.createElement('div');
  overlay.setAttribute('data-media-viewer', '1');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', type === 'video' ? 'Video player' : 'Photo viewer');
  overlay.style.cssText =
    'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'padding:16px;box-sizing:border-box;background:rgba(0,0,0,0.94);';

  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  let mediaEl;
  if (type === 'video') {
    mediaEl = document.createElement('video');
    mediaEl.src = url;
    mediaEl.controls = true;
    mediaEl.autoplay = true;
    mediaEl.preload = 'auto';
    mediaEl.setAttribute('playsinline', '');
    mediaEl.setAttribute('webkit-playsinline', '');
    mediaEl.addEventListener('error', function () {
      const box = document.createElement('div');
      box.style.cssText = 'color:#fff;text-align:center;font-size:15px;line-height:1.5;max-width:300px;';
      box.appendChild(document.createTextNode('This video could not be played here.'));
      box.appendChild(document.createElement('br'));
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open video in browser';
      a.style.cssText = 'color:#6cb4ff;font-weight:600;';
      box.appendChild(a);
      if (mediaEl.parentNode) mediaEl.parentNode.replaceChild(box, mediaEl);
    });
  } else {
    mediaEl = document.createElement('img');
    mediaEl.src = url;
    mediaEl.alt = alt || 'Photo';
  }
  mediaEl.style.cssText =
    'max-width:100%;max-height:100%;width:auto;height:auto;border-radius:10px;' +
    'background:#000;cursor:default;';
  mediaEl.addEventListener('click', function (e) { e.stopPropagation(); });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  closeBtn.style.cssText =
    'position:absolute;top:16px;right:16px;width:44px;height:44px;' +
    'border:1px solid rgba(255,255,255,0.4);border-radius:50%;' +
    'background:rgba(255,255,255,0.14);color:#fff;font-size:26px;' +
    'line-height:1;display:flex;align-items:center;justify-content:center;' +
    'cursor:pointer;padding:0;z-index:2;';

  function close() {
    if (type === 'video' && typeof mediaEl.pause === 'function') {
      try { mediaEl.pause(); } catch (e) { /* ignore */ }
    }
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.body.style.overflow = prevOverflow;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  overlay.addEventListener('click', close);
  closeBtn.addEventListener('click', function (e) { e.stopPropagation(); close(); });
  document.addEventListener('keydown', onKey);

  overlay.appendChild(mediaEl);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
}

/* =========================================================
   Composer
   ========================================================= */
function initComposer(cfg) {
  ['input', 'sendBtn', 'preview', 'error'].forEach(function (key) {
    if (!cfg[key]) {
      throw new Error('initComposer: missing "' + key + '" — check that element\'s id in the HTML.');
    }
  });
  if (!Array.isArray(cfg.attachButtons) || !cfg.attachButtons.length) {
    throw new Error('initComposer: "attachButtons" must be a non-empty array of { btn, input }.');
  }
  cfg.attachButtons.forEach(function (a, i) {
    if (!a.btn) throw new Error('initComposer: attachButtons[' + i + '].btn is missing — check its id in the HTML.');
    if (!a.input) throw new Error('initComposer: attachButtons[' + i + '].input is missing — check its id in the HTML.');
  });

  const input = cfg.input;
  const sendBtn = cfg.sendBtn;
  const attachButtons = cfg.attachButtons;
  const preview = cfg.preview;
  const errorEl = cfg.error;

  let file = null;
  let previewUrl = null;
  let busy = false;

  function refresh() {
    sendBtn.disabled = busy || !(input.value.trim() || file);
    attachButtons.forEach(function (a) { a.btn.disabled = busy; });
    sendBtn.classList.toggle('busy', busy);
  }

  function showError(msg) {
    errorEl.style.color = '';
    errorEl.textContent = msg || '';
    errorEl.hidden = !msg;
  }

  // Neutral (non-red) status line, used for upload progress.
  function showStatus(msg) {
    errorEl.style.color = 'var(--muted)';
    errorEl.textContent = msg || '';
    errorEl.hidden = !msg;
  }

  function onProgress(pct) {
    showStatus(pct >= 100 ? 'Finishing upload…' : 'Uploading… ' + pct + '%');
  }

  function resetPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    file = null;
    attachButtons.forEach(function (a) { a.input.value = ''; });
    preview.hidden = true;
    preview.innerHTML = '';
  }

  function setFile(f) {
    const problem = validateAttachment(f);
    if (problem) { showError(problem); return; }
    showError('');
    resetPreview();

    file = f;
    previewUrl = URL.createObjectURL(f);
    const kind = attachmentKind(f);

    const thumb = document.createElement(kind === 'video' ? 'video' : 'img');
    thumb.className = 'attach-thumb';
    if (kind === 'video') {
      thumb.muted = true;
      thumb.setAttribute('playsinline', '');
      thumb.preload = 'metadata';
      thumb.src = previewUrl + '#t=0.1';
    } else {
      thumb.alt = '';
      thumb.src = previewUrl;
    }

    const info = document.createElement('div');
    info.className = 'attach-info';
    const nm = document.createElement('div');
    nm.className = 'attach-name';
    nm.textContent = f.name || (kind === 'video' ? 'Video' : 'Photo');
    const meta = document.createElement('div');
    meta.className = 'attach-meta';
    meta.textContent = (kind === 'video' ? 'Video' : 'Photo') + ' · ' + formatBytes(f.size);
    info.appendChild(nm);
    info.appendChild(meta);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-remove';
    rm.setAttribute('aria-label', 'Remove attachment');
    rm.textContent = '×';
    rm.addEventListener('click', function () { resetPreview(); refresh(); });

    preview.appendChild(thumb);
    preview.appendChild(info);
    preview.appendChild(rm);
    preview.hidden = false;
    refresh();
    input.focus();
  }

  async function submit() {
    if (busy) return;
    const body = input.value.trim();
    if (!body && !file) return;

    busy = true;
    showError('');
    if (file) showStatus('Uploading… 0%');
    refresh();
    try {
      await cfg.onSubmit({ body: body, file: file, onProgress: onProgress });
      input.value = '';
      input.style.height = 'auto';
      resetPreview();
      showError('');
    } catch (ex) {
      console.error(ex);
      showError(ex && ex.message ? ex.message : 'Could not send. Please try again.');
    } finally {
      busy = false;
      refresh();
    }
  }

  attachButtons.forEach(function (a) {
    a.btn.addEventListener('click', function () { a.input.click(); });
    a.input.addEventListener('change', function () {
      if (a.input.files && a.input.files[0]) setFile(a.input.files[0]);
    });
  });

  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    refresh();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  input.addEventListener('paste', function (e) {
    const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
    if (f && attachmentKind(f)) {
      e.preventDefault();
      setFile(f);
    }
  });

  sendBtn.addEventListener('click', submit);
  refresh();
}
