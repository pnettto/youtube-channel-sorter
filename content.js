(() => {
  'use strict';

  // Matches /@name/videos, /channel/UC.../videos, /c/name/videos, /user/name/videos (and /streams)
  const TAB_RE = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/(videos|streams)\/?$/;
  const PAGE_DELAY_MS = 250;
  const RENDER_STEP = 200;
  const DAY = 864e5;
  const UNIT_MS = {
    second: 1e3, minute: 6e4, hour: 36e5, day: DAY,
    week: 7 * DAY, month: 30.4375 * DAY, year: 365.25 * DAY,
  };
  const PERIODS = [
    { id: 'all', label: 'All time' },
    { id: '7', label: 'Last 7 days', days: 7 },
    { id: '30', label: 'Last 30 days', days: 30 },
    { id: '90', label: 'Last 3 months', days: 91 },
    { id: '365', label: 'Last year', days: 365 },
    { id: 'custom', label: 'Custom range' },
  ];
  const SORTS = [
    { id: 'views-desc', label: 'Most views' },
    { id: 'views-asc', label: 'Fewest views' },
    { id: 'date-desc', label: 'Newest' },
    { id: 'date-asc', label: 'Oldest' },
    { id: 'comments-desc', label: 'Most comments', details: true },
    { id: 'likes-desc', label: 'Most likes', details: true },
    { id: 'comment-rate', label: 'Comments per view', details: true },
    { id: 'like-rate', label: 'Likes per view', details: true },
  ];
  const DETAIL_WORKERS = 4;
  const DETAIL_DELAY_MS = 150;

  const nf = new Intl.NumberFormat();
  const cache = new Map();      // pageKey -> entry
  const rowCache = new Map();   // videoId -> <li>
  const prefs = { period: 'all', sort: 'views-desc', from: '', to: '', minViews: '', query: '' };
  const ui = {};
  let current = null;
  let renderLimit = RENDER_STEP;
  let renderQueued = false;

  // ---------- helpers ----------
  const pageKey = () => {
    const m = location.pathname.match(TAB_RE);
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
  };
  const isTargetPage = () => TAB_RE.test(location.pathname);
  const isOpen = () => ui.backdrop && !ui.backdrop.hidden;

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  function txt(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (t.simpleText) return t.simpleText;
    if (t.runs) return t.runs.map(r => r.text).join('');
    if (t.content) return t.content;
    return '';
  }

  function walk(o, fn) {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      fn(k, v);
      if (v && typeof v === 'object') walk(v, fn);
    }
  }

  function sliceBalanced(s, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
    }
    throw new Error('Could not read page data.');
  }

  function extractJson(html, name) {
    for (const marker of [`var ${name} = `, `window["${name}"] = `, `${name} = `]) {
      const i = html.indexOf(marker);
      if (i !== -1) return JSON.parse(sliceBalanced(html, i + marker.length));
    }
    throw new Error(`Could not find ${name} on the page.`);
  }

  // ---------- parsing ----------
  function parseViews(s) {
    if (!s) return null;
    if (/no views/i.test(s)) return 0;
    if (/waiting|watching/i.test(s)) return null; // upcoming or currently live
    const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
    if (!m) return null;
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
    return Math.round(parseFloat(m[1]) * mult);
  }

  function parseAgo(s, now) {
    const m = (s || '').match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i);
    if (!m) return { date: null, precision: null };
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const u = UNIT_MS[unit];
    // YouTube rounds down ("1 year ago" covers 12 to 23 months), so use the middle of the bucket.
    const offset = u >= DAY ? n + 0.5 : n;
    return { date: now - offset * u, precision: unit };
  }

  function findTimeBadge(obj) {
    let found = '';
    walk(obj, (k, v) => {
      if (!found && typeof v === 'string' && /^\d{1,2}(:\d{2}){1,2}$/.test(v.trim())) found = v.trim();
    });
    return found;
  }

  function parseVideo(c, now) {
    let id, title = '', viewsText = '', agoText = '', duration = '';
    if (c.videoRenderer) {
      const r = c.videoRenderer;
      id = r.videoId;
      title = txt(r.title);
      viewsText = txt(r.viewCountText);
      agoText = txt(r.publishedTimeText);
      duration = txt(r.lengthText) || findTimeBadge(r.thumbnailOverlays);
    } else if (c.lockupViewModel) {
      const l = c.lockupViewModel;
      const md = l.metadata?.lockupMetadataViewModel;
      id = l.contentId;
      title = md?.title?.content || '';
      const texts = [];
      walk(md?.metadata, (k, v) => { if (k === 'content' && typeof v === 'string') texts.push(v); });
      viewsText = texts.find(t => /views?\b|watching|waiting/i.test(t)) || '';
      agoText = texts.find(t => /\bago\b/i.test(t)) || '';
      duration = findTimeBadge(l.contentImage);
    } else {
      return null;
    }
    if (!id) return null;
    return { id, title, viewsText, agoText, duration, views: parseViews(viewsText), ...parseAgo(agoText, now) };
  }

  function gridItemsFrom(resp) {
    const out = [];
    for (const a of resp.onResponseReceivedActions || resp.onResponseReceivedEndpoints || []) {
      const items = a.appendContinuationItemsAction?.continuationItems
        || a.reloadContinuationItemsCommand?.continuationItems;
      if (items) out.push(...items);
    }
    const tabs = resp.contents?.twoColumnBrowseResultsRenderer?.tabs;
    if (tabs) {
      const tab = tabs.map(t => t.tabRenderer).find(t => t?.content?.richGridRenderer);
      if (tab) out.push(...tab.content.richGridRenderer.contents);
    }
    return out;
  }

  function collect(entry, items) {
    let token = null;
    const now = Date.now();
    for (const it of items) {
      if (it.continuationItemRenderer) {
        token = it.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || null;
        continue;
      }
      const v = parseVideo(it.richItemRenderer?.content || it, now);
      if (v && !entry.videos.has(v.id)) {
        entry.videos.set(v.id, v);
        if (v.date != null) { entry.lastDate = v.date; entry.lastPrecision = v.precision; }
      }
    }
    return token;
  }

  // ---------- network ----------
  async function getBootstrap(url, signal) {
    const res = await fetch(url, { credentials: 'include', signal });
    if (!res.ok) throw new Error(`Page request failed (${res.status}).`);
    const html = await res.text();
    const pick = re => (html.match(re) || [])[1];
    return {
      initialData: extractJson(html, 'ytInitialData'),
      apiKey: pick(/"INNERTUBE_API_KEY":"([^"]+)"/),
      clientVersion: pick(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || '2.20251001.00.00',
      visitorData: pick(/"VISITOR_DATA":"([^"]+)"/),
    };
  }

  const browse = (boot, body, signal) => api('browse', boot, body, signal);

  async function api(endpoint, boot, body, signal) {
    const url = `/youtubei/v1/${endpoint}?prettyPrint=false` + (boot.apiKey ? `&key=${boot.apiKey}` : '');
    const headers = {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': boot.clientVersion,
    };
    if (boot.visitorData) headers['X-Goog-Visitor-Id'] = boot.visitorData;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'omit', // public data only; avoids needing auth headers
      headers,
      signal,
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: boot.clientVersion,
            hl: 'en', // force English so view counts and dates parse the same in every locale
            gl: 'US',
            ...(boot.visitorData ? { visitorData: boot.visitorData } : {}),
          },
        },
        ...body,
      }),
    });
    if (!res.ok) throw new Error(`YouTube returned ${res.status}.`);
    return res.json();
  }

  // ---------- per-video details (comments, likes, exact date) ----------
  function find(obj, test) {
    let hit;
    walk(obj, (k, v) => { if (hit === undefined && test(k, v)) hit = v; });
    return hit;
  }

  function parseDetails(resp) {
    const out = {};
    // Comments: header of the comments panel, e.g. "1,234"
    const panel = (resp.engagementPanels || [])
      .map(p => p.engagementPanelSectionListRenderer)
      .find(p => p?.panelIdentifier === 'engagement-panel-comments-section');
    let ctext = txt(panel?.header?.engagementPanelTitleHeaderRenderer?.contextualInfo);
    if (!ctext) ctext = txt(find(resp, k => k === 'commentsEntryPointHeaderRenderer')?.commentCount);
    out.comments = ctext ? parseViews(ctext) : null;
    out.commentsOff = !ctext;

    // Likes: exact number from the like button's accessibility text, else the rounded factoid
    const likeA11y = find(resp, (k, v) => typeof v === 'string' && /along with [\d,]+ other/i.test(v));
    if (likeA11y) out.likes = Number(likeA11y.match(/along with ([\d,]+)/i)[1].replace(/,/g, '')) + 1;
    else {
      const f = find(resp, (k, v) => k === 'factoidRenderer' && /^likes?$/i.test(txt(v.label)));
      out.likes = f ? parseViews(txt(f.value)) : null;
    }

    // Exact view count and upload date
    const vc = find(resp, k => k === 'videoViewCountRenderer');
    const views = parseViews(txt(vc?.viewCount));
    if (views != null) out.views = views;
    const dateText = txt(find(resp, k => k === 'videoPrimaryInfoRenderer')?.dateText)
      || txt(find(resp, k => k === 'videoDescriptionHeaderRenderer')?.publishDate);
    const dm = dateText.match(/([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/);
    if (dm) {
      const t = Date.parse(dm[1]);
      if (!Number.isNaN(t)) out.exactDate = t;
    }
    return out;
  }

  async function loadDetails(entry, videos) {
    entry.detailAbort = new AbortController();
    const signal = entry.detailAbort.signal;
    entry.detailTotal = videos.length;
    entry.detailDone = 0;
    entry.detailError = null;
    entry.detailLoading = true;
    scheduleRender();
    const queue = [...videos];
    const worker = async () => {
      while (queue.length && !signal.aborted) {
        const v = queue.shift();
        try {
          const d = parseDetails(await api('next', entry.boot, { videoId: v.id }, signal));
          v.comments = d.comments;
          v.commentsOff = d.commentsOff;
          v.likes = d.likes;
          if (d.views != null) v.views = d.views;
          if (d.exactDate != null) { v.date = d.exactDate; v.precision = 'exact'; }
          v.detailed = true;
          rowCache.delete(v.id);
        } catch (err) {
          if (err.name === 'AbortError') return;
          entry.detailError = err.message || String(err);
        }
        entry.detailDone++;
        scheduleRender();
        try { await sleep(DETAIL_DELAY_MS, signal); } catch { return; }
      }
    };
    await Promise.all(Array.from({ length: DETAIL_WORKERS }, worker));
    entry.detailLoading = false;
    scheduleRender();
  }

  function startDetails() {
    const e = current;
    if (!e?.boot || e.detailLoading) return;
    const todo = filtered().filter(v => !v.detailed);
    if (todo.length > 2000 && !confirm(`This makes ${todo.length.toLocaleString()} requests and may take a long time. Continue?`)) return;
    loadDetails(e, todo);
  }

  function selectedTab(initialData) {
    const tabs = (initialData?.contents?.twoColumnBrowseResultsRenderer?.tabs || []).map(t => t.tabRenderer).filter(Boolean);
    const tabName = location.pathname.split('/').filter(Boolean).pop();
    return tabs.find(t => t.selected)
      || tabs.find(t => (t.endpoint?.commandMetadata?.webCommandMetadata?.url || '').endsWith('/' + tabName));
  }

  // The list arrives newest first, so once the oldest loaded video is clearly
  // older than the period start, the rest of the channel is not needed.
  function pastPeriodStart(entry) {
    const [from] = getRange();
    if (from === -Infinity || entry.lastDate == null) return false;
    return entry.lastDate + (UNIT_MS[entry.lastPrecision] || DAY) < from;
  }

  function maybeResume() {
    const e = current;
    if (e && !e.loading && e.autoStopped && e.token && !pastPeriodStart(e)) ensureLoaded({ resume: true });
  }

  async function loadAll(entry) {
    const signal = entry.abort.signal;
    if (!entry.boot) {
      const boot = await getBootstrap(entry.url, signal);
      const ep = selectedTab(boot.initialData)?.endpoint?.browseEndpoint;
      if (!ep?.browseId) throw new Error('Could not find the video tab data for this channel.');
      entry.channelName = boot.initialData?.metadata?.channelMetadataRenderer?.title || '';
      const first = await browse(boot, { browseId: ep.browseId, params: ep.params }, signal);
      entry.token = collect(entry, gridItemsFrom(first));
      entry.boot = boot;
      scheduleRender();
    }
    entry.autoStopped = false;
    while (entry.token && !pastPeriodStart(entry)) {
      await sleep(PAGE_DELAY_MS, signal);
      const resp = await browse(entry.boot, { continuation: entry.token }, signal);
      entry.token = collect(entry, gridItemsFrom(resp));
      scheduleRender();
    }
    entry.autoStopped = !!entry.token;
  }

  async function ensureLoaded({ restart = false, resume = false } = {}) {
    const key = pageKey();
    if (!key) return;

    // Pause loads for other channels
    for (const e of cache.values()) if (e.key !== key && e.loading) e.abort.abort();

    let entry = cache.get(key);
    if (restart && entry) {
      entry.abort?.abort();
      entry = null;
    }
    if (!entry) {
      entry = { key, url: location.origin + location.pathname, videos: new Map(), token: null, boot: null, channelName: '' };
      cache.set(key, entry);
    }
    if (current !== entry) {
      current = entry;
      rowCache.clear();
      renderLimit = RENDER_STEP;
    }
    const finished = entry.boot && !entry.token;
    if (entry.loading || (finished && !restart) || (entry.boot && !resume && !restart)) {
      scheduleRender();
      return;
    }

    entry.abort = new AbortController();
    entry.loading = true;
    entry.error = null;
    scheduleRender();
    try {
      await loadAll(entry);
    } catch (err) {
      if (err.name !== 'AbortError') entry.error = err.message || String(err);
    } finally {
      entry.loading = false;
      scheduleRender();
    }
  }

  // ---------- filtering ----------
  function getRange() {
    const p = PERIODS.find(x => x.id === prefs.period);
    if (p?.days) return [Date.now() - p.days * DAY, Infinity];
    if (prefs.period === 'custom') {
      const from = prefs.from ? new Date(prefs.from + 'T00:00:00').getTime() : -Infinity;
      const to = prefs.to ? new Date(prefs.to + 'T23:59:59.999').getTime() : Infinity;
      return [from, to];
    }
    return [-Infinity, Infinity];
  }

  const rate = (n, views) => (n == null || !views ? null : (n / views) * 1000);

  function filtered() {
    if (!current) return [];
    const [from, to] = getRange();
    const ranged = from !== -Infinity || to !== Infinity;
    const min = prefs.minViews.trim() ? parseViews(prefs.minViews) : null;
    const q = prefs.query.trim().toLowerCase();
    const big = Number.MAX_SAFE_INTEGER;
    const cmp = {
      'views-desc': (a, b) => (b.views ?? -1) - (a.views ?? -1),
      'views-asc': (a, b) => (a.views ?? big) - (b.views ?? big),
      'date-desc': (a, b) => (b.date ?? 0) - (a.date ?? 0),
      'date-asc': (a, b) => (a.date ?? big) - (b.date ?? big),
      'comments-desc': (a, b) => (b.comments ?? -1) - (a.comments ?? -1),
      'likes-desc': (a, b) => (b.likes ?? -1) - (a.likes ?? -1),
      'comment-rate': (a, b) => (rate(b.comments, b.views) ?? -1) - (rate(a.comments, a.views) ?? -1),
      'like-rate': (a, b) => (rate(b.likes, b.views) ?? -1) - (rate(a.likes, a.views) ?? -1),
    }[prefs.sort];
    return [...current.videos.values()]
      .filter(v => {
        if (ranged && (v.date == null || v.date < from || v.date > to)) return false;
        if (min != null && (v.views ?? -1) < min) return false;
        if (q && !v.title.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort(cmp);
  }

  // ---------- rendering ----------
  function formatDate(v) {
    if (v.date == null) return '';
    if (['second', 'minute', 'hour'].includes(v.precision)) return '';
    if (v.precision === 'exact') return new Date(v.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const opts = ['month', 'year'].includes(v.precision)
      ? { year: 'numeric', month: 'short' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
    return `approx. ${new Date(v.date).toLocaleDateString(undefined, opts)}`;
  }

  function rowFor(v) {
    let li = rowCache.get(v.id);
    if (li) return li;
    li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <span class="rank"></span>
      <a class="thumb" tabindex="-1"><img loading="lazy" alt=""><span class="duration"></span></a>
      <div class="info">
        <a class="title"></a>
        <div class="meta"><span class="views"></span><span class="date"></span></div>
        <div class="meta stats"></div>
      </div>`;
    const href = `/watch?v=${encodeURIComponent(v.id)}`;
    li.querySelector('.thumb').href = href;
    li.querySelector('img').src = `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`;
    const dur = li.querySelector('.duration');
    if (v.duration) dur.textContent = v.duration; else dur.remove();
    const title = li.querySelector('.title');
    title.href = href;
    title.textContent = v.title;
    title.title = v.title;
    li.querySelector('.views').textContent = v.views == null
      ? (v.viewsText || 'Views unavailable')
      : `${nf.format(v.views)} views`;
    const est = formatDate(v);
    li.querySelector('.date').textContent = v.precision === 'exact'
      ? est
      : v.agoText ? (est ? `${v.agoText} (${est})` : v.agoText) : 'Date unavailable';
    const stats = li.querySelector('.stats');
    if (v.detailed) {
      const parts = [];
      if (v.commentsOff) parts.push('Comments off');
      else if (v.comments != null) {
        parts.push(`${nf.format(v.comments)} comments`);
        const r = rate(v.comments, v.views);
        if (r != null) parts.push(`${r.toFixed(1)} per 1K views`);
      }
      if (v.likes != null) {
        parts.push(`${nf.format(v.likes)} likes`);
        const r = rate(v.likes, v.views);
        if (r != null) parts.push(`${r.toFixed(1)} per 1K views`);
      }
      for (const t of parts) {
        const sp = document.createElement('span');
        sp.textContent = t;
        stats.append(sp);
      }
    } else stats.remove();
    rowCache.set(v.id, li);
    return li;
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  function render() {
    renderQueued = false;
    if (!isOpen() || !current) return;
    const e = current;
    const total = e.videos.size;

    ui.channel.textContent = e.channelName;
    let status;
    if (e.error) status = `Loading stopped: ${e.error}`;
    else if (e.loading) status = `Loading videos… ${nf.format(total)} so far`;
    else if (!e.boot) status = 'Not loaded yet';
    else if (e.token && e.autoStopped) status = `${nf.format(total)} videos loaded, covering the selected period`;
    else if (e.token) status = `Paused at ${nf.format(total)} videos`;
    else status = `All ${nf.format(total)} videos loaded`;
    ui.statusText.textContent = status;
    ui.backdrop.classList.toggle('is-loading', !!(e.loading || e.detailLoading));

    ui.stop.hidden = !e.loading;
    ui.resume.hidden = e.loading || (e.boot && !e.token);
    ui.reload.hidden = e.loading || !e.boot;

    const list = filtered();
    const sum = list.reduce((a, v) => a + (v.views || 0), 0);
    ui.summary.textContent = `${nf.format(list.length)} of ${nf.format(total)} videos match, ${nf.format(sum)} views combined`;
    ui.csv.disabled = list.length === 0;

    const missing = list.filter(v => !v.detailed).length;
    ui.details.hidden = !!e.detailLoading || !e.boot || missing === 0;
    ui.details.textContent = `Load comments and likes (${nf.format(missing)})`;
    ui.stopDetails.hidden = !e.detailLoading;
    const needsDetails = SORTS.find(x => x.id === prefs.sort)?.details;
    let dstatus = '';
    if (e.detailLoading) dstatus = `Loading comments and likes… ${nf.format(e.detailDone)} of ${nf.format(e.detailTotal)}`;
    else if (e.detailError) dstatus = `Some details failed to load: ${e.detailError}`;
    else if (needsDetails && missing) dstatus = `${nf.format(missing)} matching videos have no comment or like data yet and are listed last.`;
    ui.detailStatus.textContent = dstatus;
    ui.detailStatus.hidden = !dstatus;

    const frag = document.createDocumentFragment();
    list.slice(0, renderLimit).forEach((v, i) => {
      const li = rowFor(v);
      li.querySelector('.rank').textContent = i + 1;
      frag.append(li);
    });
    ui.results.replaceChildren(frag);
    ui.moreWrap.hidden = list.length <= renderLimit;
    ui.empty.hidden = list.length > 0 || (e.loading && total === 0);
    ui.empty.textContent = total === 0
      ? 'No videos found on this tab.'
      : 'No videos match. Widen the period or clear the filters.';
  }

  // ---------- CSV ----------
  function exportCsv() {
    const list = filtered();
    const rows = [['Rank', 'Title', 'Views', 'Comments', 'Likes', 'Published (as shown)', 'Date', 'Date is exact', 'Duration', 'URL']];
    list.forEach((v, i) => rows.push([
      i + 1, v.title, v.views ?? '', v.comments ?? '', v.likes ?? '', v.agoText,
      v.date ? new Date(v.date).toISOString().slice(0, 10) : '', v.precision === 'exact' ? 'yes' : 'no',
      v.duration, `https://www.youtube.com/watch?v=${v.id}`,
    ]));
    const csv = rows.map(r => r.map(c => {
      const s = String(c);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(current.channelName || 'channel').replace(/[^\p{L}\p{N}_-]+/gu, '_')}_videos.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- UI ----------
  function chipGroup(container, items, key) {
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = item.label;
      b.dataset.id = item.id;
      b.addEventListener('click', () => {
        prefs[key] = item.id;
        syncControls();
        if (key === 'period') maybeResume();
        renderLimit = RENDER_STEP;
        scheduleRender();
      });
      container.append(b);
    }
  }

  function syncControls() {
    for (const b of ui.periodChips.children) b.setAttribute('aria-pressed', b.dataset.id === prefs.period);
    for (const b of ui.sortChips.children) b.setAttribute('aria-pressed', b.dataset.id === prefs.sort);
    ui.customRow.hidden = prefs.period !== 'custom';
  }

  function syncTheme() {
    ui.host?.toggleAttribute('dark', document.documentElement.hasAttribute('dark'));
  }

  function open() {
    ui.backdrop.hidden = false;
    document.body.style.overflow = 'hidden';
    ensureLoaded();
    scheduleRender();
    ui.close.focus();
  }

  function close() {
    ui.backdrop.hidden = true;
    document.body.style.overflow = '';
    ui.launcher.focus();
  }

  const ICON_FILTER = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M3 6h18v2H3zm4 5h10v2H7zm3 5h4v2h-4z"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'yt-channel-sorter';
    const root = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('panel.css');
    root.append(link);
    const tpl = document.createElement('template');
    tpl.innerHTML = `
      <button type="button" class="launcher" hidden>${ICON_FILTER}<span>Sort and filter</span></button>
      <div class="backdrop" hidden>
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="ycs-title">
          <header class="head">
            <div class="heading">
              <h2 id="ycs-title">Sort and filter videos</h2>
              <p class="channel"></p>
            </div>
            <button type="button" class="icon-btn close" aria-label="Close">${ICON_CLOSE}</button>
          </header>
          <section class="controls">
            <div class="row">
              <span class="label">Period</span>
              <div class="chips period"></div>
            </div>
            <div class="row custom" hidden>
              <span class="label">Range</span>
              <div class="fields">
                <label class="field"><span>From</span><input type="date" class="from"></label>
                <label class="field"><span>To</span><input type="date" class="to"></label>
              </div>
            </div>
            <div class="row">
              <span class="label">Sort by</span>
              <div class="chips sort"></div>
            </div>
            <div class="row">
              <span class="label">Refine</span>
              <div class="fields">
                <input type="search" class="input query" placeholder="Title contains" aria-label="Title contains">
                <input type="text" class="input min" placeholder="Minimum views, e.g. 100K" aria-label="Minimum views">
              </div>
            </div>
          </section>
          <div class="statusbar">
            <div class="status">
              <span class="status-text" aria-live="polite"></span>
              <span class="summary"></span>
              <span class="summary detail-status" hidden></span>
            </div>
            <div class="actions">
              <button type="button" class="btn stop" hidden>Stop</button>
              <button type="button" class="btn resume" hidden>Continue loading</button>
              <button type="button" class="btn reload" hidden>Reload</button>
              <button type="button" class="btn details" hidden></button>
              <button type="button" class="btn stop-details" hidden>Stop details</button>
              <button type="button" class="btn csv">Export CSV</button>
            </div>
            <div class="progress"></div>
          </div>
          <div class="scroll">
            <ol class="results"></ol>
            <p class="empty" hidden></p>
            <div class="more-wrap" hidden><button type="button" class="btn more">Show more</button></div>
            <p class="note">Upload dates are estimated from YouTube’s relative times such as “2 years ago”. Older videos close to a period’s edges may fall on the wrong side of it. Loading comments and likes also fetches each video’s exact upload date. It makes one request per video, so narrow the period first on large channels.</p>
          </div>
        </div>
      </div>`;
    root.append(tpl.content);
    document.body.append(host);

    const $ = s => root.querySelector(s);
    Object.assign(ui, {
      host, root,
      launcher: $('.launcher'), backdrop: $('.backdrop'), close: $('.close'), channel: $('.channel'),
      periodChips: $('.chips.period'), sortChips: $('.chips.sort'), customRow: $('.row.custom'),
      from: $('.from'), to: $('.to'), query: $('.query'), min: $('.min'),
      statusText: $('.status-text'), summary: $('.summary'),
      stop: $('.stop'), details: $('.details'), stopDetails: $('.stop-details'), detailStatus: $('.detail-status'), resume: $('.resume'), reload: $('.reload'), csv: $('.csv'),
      results: $('.results'), empty: $('.empty'), moreWrap: $('.more-wrap'), more: $('.more'),
    });

    chipGroup(ui.periodChips, PERIODS, 'period');
    chipGroup(ui.sortChips, SORTS, 'sort');
    syncControls();

    const onInput = (el, key) => el.addEventListener('input', () => {
      prefs[key] = el.value;
      if (key === 'from') maybeResume();
      renderLimit = RENDER_STEP;
      scheduleRender();
    });
    onInput(ui.from, 'from');
    onInput(ui.to, 'to');
    onInput(ui.query, 'query');
    onInput(ui.min, 'minViews');

    ui.launcher.addEventListener('click', open);
    ui.close.addEventListener('click', close);
    ui.backdrop.addEventListener('mousedown', e => { if (e.target === ui.backdrop) close(); });
    ui.stop.addEventListener('click', () => current?.abort?.abort());
    ui.resume.addEventListener('click', () => ensureLoaded({ resume: true }));
    ui.reload.addEventListener('click', () => ensureLoaded({ restart: true }));
    ui.csv.addEventListener('click', exportCsv);
    ui.details.addEventListener('click', startDetails);
    ui.stopDetails.addEventListener('click', () => current?.detailAbort?.abort());
    ui.more.addEventListener('click', () => { renderLimit += RENDER_STEP; scheduleRender(); });

    // Keep YouTube's keyboard shortcuts from firing while typing in the panel
    for (const type of ['keydown', 'keyup', 'keypress']) {
      host.addEventListener(type, e => {
        if (type === 'keydown' && e.key === 'Escape' && isOpen()) close();
        e.stopPropagation();
      });
    }

    syncTheme();
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
  }

  function onNavigate() {
    if (!ui.host) return;
    const target = isTargetPage();
    ui.launcher.hidden = !target;
    if (!target && isOpen()) close();
    else if (target && isOpen()) ensureLoaded();
  }

  buildUI();
  onNavigate();
  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', onNavigate);
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      onNavigate();
    }
  }, 1000);
})();
