// ==UserScript==
// @name         Strava 工具箱
// @namespace    http://cbm.im/
// @version      1.5.1
// @description  自动点赞（按活动日期 / 白黑名单 / 可暂停）；评论一键 @ 回复；环形悬浮球面板；个人主页训练统计；付费推广分类隐藏
// @author       左³
// @license      Apache-2.0
// @homepageURL  https://www.strava.com/athletes/142433407
// @supportURL   https://www.strava.com/athletes/142433407
// @match        https://www.strava.com/dashboard*
// @match        https://www.strava.com/feed*
// @match        https://www.strava.com/activities/*
// @match        https://www.strava.com/clubs/*
// @match        https://www.strava.com/athletes/*
// @match        https://strava-embeds.com/activity/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 实测依据（Strava Web）：
 *   活动点赞：POST /feed/activity/{activityId}/kudo   需要 x-csrf-token（<meta name="csrf">）
 *                                            返回 {"success":"true"}
 *   点赞名单：GET  /feed/activity/{activityId}/kudos  返回 {is_owner, kudosable, athletes}
 *   信息流卡片：[data-testid="web-feed-entry"]
 *       kudos 按钮 [data-testid="kudos_button"]，内部 svg 为 unfilled_kudos / filled_kudos
 *       title 语义：点赞 / 成为第一个点赞的人！  → 可点
 *                   查看所有赞                   → 已赞 或 本人活动
 *       title 为空 = 还没水合完成，必须跳过而不是永久排除
 *   卡片类型：/activities/{id} 是活动；/clubs/{id}/posts/{id} 是俱乐部动态（接口不同，走 UI 点击）
 *   翻页：无分页条，滚动到底追加，每批 10 条，偶发一轮不加载，需要重试
 *   嵌入页：strava-embeds.com 只读，无点赞控件
 *   本人活动：详情页 ownedByCurrentAthlete=true / canKudo=false，接口直接 302，服务端拒绝
 *   日期：卡片 <time> 文本为「今天于 HH:MM」「昨天」「2026年11月7日 于 HH:MM」；俱乐部动态无 time
 *   到底：底部出现「没有更多近期活动」文案，即 Strava 信息流只到最近约 10 天
 *   评论：活动页评论在 role=dialog 弹层；条目 [data-testid="entry"][data-comment-id]
 *         作者名取条目内第一个有文字的 a[href^="/athletes/"]（头像链接无文字）
 *         输入框 [data-testid="comments-form"] textarea（placeholder 添加评论，通过 @ 提及）
 *         原生 value setter + input 事件可写入并被 React 接受，发布按钮由 disabled 变为可用
 *   他人主页：/athletes/{id} 复用 web-feed-entry 卡片，可对更早（超出 10 天）的活动点赞
 *   关注列表：GET /athletes/{me}/follows?type=following&page=N 返回 HTML，
 *             li[data-athlete-id] 内含 /athletes/{id} 名字链接，每页 25 人
 *   统计：自己的 /athletes/{me}/training/log 在 __NEXT_DATA__.props.pageProps.entriesResponse
 *         里带 12 周结构化数据（start_date / distance），可算准确周期；他人训练日志 403，
 *         只能读其主页已加载的 web-feed-entry 卡片（滚动后仍只有最近几条）
 */

(function () {
  'use strict';

  if (window.__STRAVA_AUTO_KUDOS__) return;
  window.__STRAVA_AUTO_KUDOS__ = true;

  const LS_DONE = 'sak:done:v2';
  const LS_CFG = 'sak:cfg:v2';
  const LS_LAST = 'sak:last:v1';
  const DONE_TTL = 30 * 24 * 3600 * 1000;

  const PROMO_PARTS = ['header', 'feed', 'modules', 'footer', 'text'];

  const DEFAULTS = {
    minDelay: 2000,
    maxDelay: 4000,
    dryRun: false,
    clubPosts: true,
    autoStart: false,
    range: '7',
    from: '',
    to: '',
    scope: 'all',      // all 全部点赞 | white 只给白名单 | black 跳过黑名单
    white: [],
    black: [],
    following: null,   // [{id, name}] 关注列表缓存
    promo: { header: true, feed: true, modules: true, footer: true, text: true },
    fab: null,         // {side:'left'|'right', y} 或 {x, y}
    tab: 'kudos',      // 面板当前标签页
  };

  const saved = readJSON(localStorage.getItem(LS_CFG));
  const cfg = Object.assign({}, DEFAULTS, saved);
  if (['today', '3', '7', '10', 'all', 'custom'].indexOf(cfg.range) === -1) cfg.range = '7';
  if (['all', 'white', 'black'].indexOf(cfg.scope) === -1) cfg.scope = 'all';
  if (!Array.isArray(cfg.white)) cfg.white = [];
  if (!Array.isArray(cfg.black)) cfg.black = [];
  if (cfg.following && !Array.isArray(cfg.following)) cfg.following = null;
  // 旧版只有一个 hidePromo 开关，升级后按它初始化五个细分项
  if (!saved.promo || typeof saved.promo !== 'object') {
    const on = saved.hidePromo !== false;
    cfg.promo = { header: on, feed: on, modules: on, footer: on, text: on };
  }
  PROMO_PARTS.forEach((k) => {
    if (typeof cfg.promo[k] !== 'boolean') cfg.promo[k] = true;
  });
  delete cfg.hidePromo;
  delete cfg.limit;
  if (!cfg.fab || typeof cfg.fab !== 'object') cfg.fab = null;
  const state = {
    running: false,
    mode: 'feed',
    liked: 0,
    previewed: 0,
    scanned: 0,
    inRange: 0,
    reason: '',
  };
  const processed = new Set();
  const done = loadDone();

  /* ---------------- 通用工具 ---------------- */
  function readJSON(s) {
    try { return JSON.parse(s) || {}; } catch (e) { return {}; }
  }
  function saveCfg() {
    localStorage.setItem(LS_CFG, JSON.stringify(cfg));
  }
  function loadDone() {
    const o = readJSON(localStorage.getItem(LS_DONE));
    const now = Date.now();
    Object.keys(o).forEach((k) => { if (now - o[k] > DONE_TTL) delete o[k]; });
    return o;
  }
  function saveDone() {
    localStorage.setItem(LS_DONE, JSON.stringify(done));
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a));

  /* ---------------- 页面识别 ---------------- */
  const isEmbed = () => location.hostname === 'strava-embeds.com';
  const isActivityPage = () => /^\/activities\/\d+/.test(location.pathname);

  function myAthleteId() {
    const el = document.querySelector('header a[href^="/athletes/"]');
    const id = el && (el.getAttribute('href').match(/athletes\/(\d+)/) || [])[1];
    return id || null;
  }

  /* ---------------- 卡片识别 ---------------- */
  function cards() {
    return document.querySelectorAll('[data-testid="web-feed-entry"]');
  }

  function idsIn(node) {
    const ids = new Set();
    node.querySelectorAll('a[href*="/activities/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/activities\/(\d+)/);
      if (m) ids.add(m[1]);
    });
    return ids;
  }

  // 合并卡（多人同骑）一张卡里可能有多个活动和多个点赞按钮，必须按按钮定位到各自的活动块
  function blockOf(btn) {
    let node = btn;
    for (let up = 0; up < 12 && node; up++) {
      node = node.parentElement;
      if (!node) return null;
      const ids = idsIn(node);
      if (ids.size === 1) return node;
      if (ids.size > 1) return null; // 已到整卡层级，说明该按钮不属于单一活动
    }
    return null;
  }

  function blockInfo(btn, card) {
    const block = blockOf(btn) || card;
    const ids = idsIn(block);
    if (ids.size === 1) {
      const id = ids.values().next().value;
      return { type: 'activity', id, key: 'a:' + id, block };
    }
    const post = block.querySelector('a[href*="/clubs/"][href*="/posts/"]');
    if (post) {
      const m = post.getAttribute('href').match(/posts\/(\d+)/);
      if (m) return { type: 'post', id: m[1], key: 'p:' + m[1], block };
    }
    return null;
  }

  function blockAuthor(node) {
    const links = node.querySelectorAll('a[href^="/athletes/"]');
    for (let i = 0; i < links.length; i++) {
      const name = (links[i].textContent || '').trim();
      if (!name) continue;
      const m = (links[i].getAttribute('href') || '').match(/athletes\/(\d+)/);
      return { id: m ? m[1] : null, name: name };
    }
    return { id: null, name: '' };
  }

  // 活动标题：优先取活动链接文字，其次取卡片标题
  function blockTitle(node) {
    const a = node.querySelector('a[href*="/activities/"], a[href*="/posts/"]');
    let t = a ? a.textContent : '';
    if (!t || !t.trim()) {
      const h = node.querySelector('h3');
      t = h ? h.textContent : '';
    }
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  /* ---------------- 白名单 / 黑名单 ---------------- */
  // Strava 的名字渲染会带空格（"抽 离"），匹配前统一去掉空白再比
  function normName(s) {
    return String(s || '').replace(/\s+/g, '').toLowerCase();
  }

  // 名单里可以写名字，也可以直接写 athlete id
  function inList(list, id, name) {
    if (!list || !list.length) return false;
    const n = normName(name);
    for (let i = 0; i < list.length; i++) {
      const t = String(list[i] || '').trim();
      if (!t) continue;
      if (id && t === id) return true;
      if (n && normName(t) === n) return true;
    }
    return false;
  }

  // 当前活动作者是否放行（白名单/黑名单/全部）
  function allowed(author) {
    if (cfg.scope === 'white') return inList(cfg.white, author.id, author.name);
    if (cfg.scope === 'black') return !inList(cfg.black, author.id, author.name);
    return true;
  }

  /* ---------------- 日期：卡片时间 → 本地日期 ---------------- */
  const DAY = 24 * 3600 * 1000;

  function startOfDay(d) {
    const x = new Date(d.getTime());
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function parseDateText(txt) {
    if (!txt) return null;
    const now = new Date();
    const today = startOfDay(now);
    if (/今天/.test(txt) || /today/i.test(txt)) return today;
    if (/昨天/.test(txt) || /yesterday/i.test(txt)) return new Date(today.getTime() - DAY);
    if (/前天/.test(txt)) return new Date(today.getTime() - 2 * DAY);

    let m = txt.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = txt.match(/(\d{1,2})月(\d{1,2})日/);
    if (m) return new Date(now.getFullYear(), +m[1] - 1, +m[2]);
    m = txt.match(/(\d+)\s*天前/);
    if (m) return new Date(today.getTime() - (+m[1]) * DAY);
    return null;
  }

  // 只认 <time>，不猜正文里的日期（标题常带日期，容易误判）
  function cardDate(card) {
    const t = card.querySelector('time');
    if (!t) return null;
    const dt = t.getAttribute('datetime');
    if (dt) {
      const d = new Date(dt);
      if (!isNaN(d.getTime())) return startOfDay(d);
    }
    return parseDateText((t.textContent || '').trim());
  }

  function rangeBounds() {
    const today = startOfDay(new Date());
    if (cfg.range === 'custom') {
      const from = cfg.from ? startOfDay(new Date(cfg.from + 'T00:00:00')) : null;
      const to = cfg.to ? startOfDay(new Date(cfg.to + 'T00:00:00')) : null;
      return { from: from && !isNaN(from) ? from : null, to: to && !isNaN(to) ? to : null };
    }
    if (cfg.range === 'today') return { from: today, to: today };
    const n = parseInt(cfg.range, 10) || 7;
    return { from: new Date(today.getTime() - (n - 1) * DAY), to: today };
  }

  function inRange(d) {
    if (cfg.range === 'all') return true;
    if (!d) return false;
    const b = rangeBounds();
    if (b.from && d < b.from) return false;
    if (b.to && d > b.to) return false;
    return true;
  }

  function countInRange(list) {
    if (cfg.range === 'all') return list.length;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      if (inRange(cardDate(list[i]))) n++;
    }
    return n;
  }

  // 每次都重新判定标题，绝不往 DOM 上写"跳过"标记（水合前 title 为空会被误杀）
  // 以「点赞按钮」为最小单位：合并卡里的每个活动各算一条
  function pick() {
    const me = myAthleteId();
    const list = cards();
    state.scanned = list.length;
    state.inRange = countInRange(list);

    const btns = document.querySelectorAll('[data-testid="kudos_button"]');
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      const title = btn.getAttribute('title') || '';
      if (title !== '点赞' && title !== '成为第一个点赞的人！') continue;

      const card = btn.closest('[data-testid="web-feed-entry"]');
      if (!card) continue;

      const info = blockInfo(btn, card);
      if (!info) continue;
      if (info.type === 'post' && !cfg.clubPosts) continue;
      if (processed.has(info.key) || done[info.key]) continue;
      if (!inRange(cardDate(card))) continue;

      let author = blockAuthor(info.block);
      if (!author.id && !author.name) author = blockAuthor(card);
      if (me && author.id === me) continue;
      if (!allowed(author)) continue;
      const actTitle = blockTitle(info.block) || blockTitle(card);
      return { card, btn, block: info.block, type: info.type, id: info.id, key: info.key, author: author, title: actTitle };
    }
    return null;
  }

  /* ---------------- 点赞 ---------------- */
  function csrfToken() {
    const m = document.querySelector('meta[name="csrf"]') || document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') || '' : '';
  }

  async function postKudo(id) {
    if (cfg.dryRun) return true;
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
    };
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;

    const res = await fetch('/feed/activity/' + id + '/kudo', {
      method: 'POST',
      credentials: 'include',
      headers: headers,
    });
    const text = await res.text();
    let ok = false;
    try {
      const j = JSON.parse(text);
      ok = j.success === 'true' || j.success === true;
    } catch (e) { ok = false; }

    if (!ok) {
      if (res.status === 401) throw new Error('401 未授权：CSRF 失效，刷新页面后重试');
      if (res.status === 429) throw new Error('429 请求过于频繁，已被限流，请稍后再试');
      throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 60).replace(/\s+/g, ' '));
    }
    return true;
  }

  // 俱乐部动态没有稳定的公开接口，交给前端自己发请求
  async function clickKudo(btn) {
    if (cfg.dryRun) return true;
    btn.click();
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      const svg = btn.querySelector('svg');
      if (svg && svg.getAttribute('data-testid') === 'filled_kudos') return true;
    }
    throw new Error('俱乐部动态点赞未生效');
  }

  function paint(btn) {
    btn.setAttribute('title', '查看所有赞');
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.setAttribute('data-testid', 'filled_kudos');
      svg.setAttribute('fill', '#fc5200');
    }
  }

  function bumpCount(card) {
    ['kudos_count', 'kudos_count_button'].forEach((t) => {
      const el = card.querySelector('[data-testid="' + t + '"]');
      if (!el) return;
      const raw = el.textContent || '';
      const m = raw.match(/(\d+)/);
      if (m) el.textContent = raw.replace(/\d+/, String(parseInt(m[1], 10) + 1));
    });
    const give = card.querySelector('[data-testid="give_kudos_button"]');
    if (give) {
      const raw = give.textContent || '';
      give.textContent = /(\d+)/.test(raw) ? raw.replace(/\d+/, '1') : '1 赞';
    }
  }

  async function likeOne(c) {
    if (c.type === 'activity') await postKudo(c.id);
    else await clickKudo(c.btn);

    processed.add(c.key);
    paint(c.btn);
    bumpCount(c.block);

    if (cfg.dryRun) {
      state.previewed++;
      log('预览 ' + label(c));
    } else {
      done[c.key] = Date.now();
      saveDone();
      state.liked++;
      saveLast(c);
      log('已赞 ' + label(c));
    }
    render();
  }

  // 记录最近一次点赞，供点赞面板的「点赞统计」使用
  function saveLast(c) {
    try {
      localStorage.setItem(LS_LAST, JSON.stringify({
        type: c.type || 'activity',
        who: (c.author && c.author.name) || '',
        title: c.title || '',
        at: Date.now(),
      }));
    } catch (e) { /* 存储失败不影响点赞 */ }
  }

  // 日志只显示"谁 + 什么活动"，不暴露活动 id
  function label(c) {
    const who = (c.author && c.author.name) || '未知用户';
    const what = c.title || (c.type === 'post' ? '俱乐部动态' : '活动');
    const s = who + ' · ' + what;
    return s.length > 46 ? s.slice(0, 46) + '…' : s;
  }

  /* ---------------- 关注列表 ---------------- */
  // 关注页是服务端渲染的 HTML 列表，li[data-athlete-id] 里带名字，按 page 翻页
  async function loadFollowing(onProgress) {
    const me = myAthleteId();
    if (!me) throw new Error('未识别到自己的 athlete id，请回到首页重试');
    const map = new Map();
    for (let page = 1; page <= 40; page++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      let res;
      try {
        res = await fetch('/athletes/' + me + '/follows?type=following&page=' + page, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        break;
      }
      clearTimeout(timer);
      if (!res.ok) break;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      let added = 0;
      doc.querySelectorAll('li[data-athlete-id]').forEach((li) => {
        const id = li.getAttribute('data-athlete-id');
        const a = li.querySelector('a[href^="/athletes/"]');
        const name = a ? (a.textContent || '').trim() : '';
        if (!id || id === me || !name || map.has(id)) return;
        map.set(id, name);
        added++;
      });
      if (typeof onProgress === 'function') onProgress(map.size);
      if (!added) break;
      await sleep(250);
    }
    if (!map.size) throw new Error('没读到关注列表，可能页面结构已变化');
    cfg.following = Array.from(map, (x) => ({ id: x[0], name: x[1] }));
    saveCfg();
    return cfg.following.length;
  }

  // 等待期间检查暂停，让"暂停"能在 200ms 内生效
  async function nap(ms) {
    const end = Date.now() + ms;
    let left = ms;
    while (left > 0) {
      if (!state.running) return false;
      await sleep(Math.min(200, left));
      left = end - Date.now();
    }
    return true;
  }

  /* ---------------- 隐藏付费推广（分五类，可单独开关） ---------------- */
  const PROMO_ATTR = 'data-sak-promo';
  const PROMO_TEXT = /开始试用|免费试用|立即试用|升级|订阅|Premium|Try for free|Upgrade|Subscribe/i;
  const PROMO_SEL = '[class*="Upsell"], [class*="upsell"], [class*="Promo"], [class*="promo"], ' +
    '[class*="Trial"], [class*="trial"], [class*="Upgrade"], [class*="upgrade"], ' +
    '[class*="Banner"], [class*="banner"]';
  const PROMO_CSS = [
    // 顶部导航的订阅 / 升级入口
    'html.sak-p-header header a[href*="/subscribe"]',
    'html.sak-p-header header a[href*="/premium"]',
    'html.sak-p-header header a.upgrade',
    // 信息流里投放的推广卡片（PromoEntry_ / 广告图片）
    'html.sak-p-feed [data-testid="web-feed-entry"]:has([class*="PromoEntry_"])',
    'html.sak-p-feed [data-testid="web-feed-entry"]:has([data-testid="promo-img"])',
    // 非会员专属模块：相对负荷度、目标引导等
    'html.sak-p-modules [class*="GoalsUpsell_"]',
    'html.sak-p-modules.sak-free [class*="RelativeEffort_"]',
    'html.sak-p-modules [class*="NoAccess_graphic"]',
    'html.sak-p-modules [class*="NoAccess_description"]',
    'html.sak-p-modules a[href*="/subscribe"][href*="origin=dashboard"]',
    // 页脚订阅 / 优惠入口
    'html.sak-p-footer li:has(> a[href*="origin=global_footer"])',
    'html.sak-p-footer li:has(> a[href*="/premium"])',
    'html.sak-p-footer li:has(> a[href*="/student"])',
    'html.sak-p-footer li:has(> a[href*="/family"])',
    'html.sak-p-footer li:has(> a[href*="/bulk-subscriptions"])',
    'html.sak-p-footer li:has(> a[href*="discount-plans"])',
    'html.sak-p-footer li:has(> a[href*="/gift"])',
    'html.sak-p-footer li:has(> a[href*="origin=dashboard_footer"])',
    'html.sak-p-footer a[href*="/subscribe"][href*="origin=dashboard_footer"]',
    // 其它命中推广文案的小块
    'html.sak-p-text [' + PROMO_ATTR + '="1"]',
  ].join(',') + '{display:none!important}';

  let promoObs = null;
  let promoTimer = 0;

  // 页面上出现订阅入口，说明当前是未付费账号（会员不会渲染这些入口）
  function isFreePage() {
    return !!document.querySelector(
      '[class*="NoAccess_"], [class*="GoalsUpsell_"], header a[href*="/subscribe"]'
    );
  }

  // 只标记"带推广类名 + 文案命中 + 不是信息流卡片"的小块，避免误伤正常内容
  function markPromos() {
    if (!cfg.promo.text) return;
    const nodes = document.querySelectorAll(PROMO_SEL);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.hasAttribute(PROMO_ATTR)) continue;
      if (el.closest('[data-testid="web-feed-entry"]')) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 160 || !PROMO_TEXT.test(text)) continue;
      if (el.getBoundingClientRect().height > 420) continue;
      el.setAttribute(PROMO_ATTR, '1');
    }
  }

  // 会员状态与推广元素会异步渲染，每次同步都重新判定
  function syncPromo() {
    const root = document.documentElement;
    PROMO_PARTS.forEach((k) => root.classList.toggle('sak-p-' + k, !!cfg.promo[k]));
    root.classList.toggle('sak-free', !!cfg.promo.modules && isFreePage());
    markPromos();
  }

  function applyPromo() {
    let st = document.getElementById('sak-promo-css');
    if (!st) {
      st = document.createElement('style');
      st.id = 'sak-promo-css';
      st.textContent = PROMO_CSS;
      document.head.appendChild(st);
    }
    syncPromo();
    if (promoObs) return;
    promoObs = new MutationObserver(() => {
      clearTimeout(promoTimer);
      promoTimer = setTimeout(syncPromo, 400);
    });
    promoObs.observe(document.body, { childList: true, subtree: true });
  }

  /* ---------------- 翻页：滚动加载，偶发失败要重试 ---------------- */
  async function loadMore() {
    const before = cards().length;
    window.scrollBy(0, -400);
    await sleep(150);
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(900);
    if (cards().length > before) return true;

    window.scrollBy(0, -250);
    await sleep(150);
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(900);
    return cards().length > before;
  }

  // 信息流有硬性窗口：底部出现这句就说明 Strava 不再提供更早的活动
  function feedEnded() {
    const t = document.body ? (document.body.innerText || '') : '';
    return /没有更多近期活动|没有更多活动|No more recent activities/i.test(t);
  }

  /* ---------------- 主循环 ---------------- */
  async function run() {
    if (state.running) return;
    if (isEmbed()) { setStatus('嵌入页只读，无法点赞'); return; }
    if (cfg.scope === 'white' && !cfg.white.length) { setStatus('白名单为空，先添加要点赞的人', 'err'); return; }

    state.running = true;
    state.liked = 0;
    state.previewed = 0;
    state.inRange = 0;
    state.reason = '';
    setStatus('运行中');
    render();

    let idle = 0;
    while (state.running) {
      const c = pick();
      if (c) {
        idle = 0;
        try {
          await likeOne(c);
        } catch (err) {
          const msg = err.message || String(err);
          // 令牌/限流属于全局问题，直接停；单条失败只跳过，别影响整体
          if (/401|429/.test(msg)) {
            state.reason = 'error';
            setStatus('已停止：' + msg, 'err');
            log('失败：' + msg);
            break;
          }
          processed.add(c.key);
          log('跳过 ' + label(c) + '：' + msg);
        }
        if (!(await nap(rand(cfg.minDelay, cfg.maxDelay)))) break;
        continue;
      }

      idle++;
      if (idle === 2) setStatus('正在加载更多…');
      const grew = await loadMore();
      if (grew) { idle = 0; continue; }
      if (feedEnded()) { state.reason = 'bottom'; break; }
      if (idle >= 8) { state.reason = 'end'; break; }
      await sleep(600);
    }

    state.running = false;
    if (state.reason === 'bottom') setStatus('已到信息流末尾：Strava 只提供最近约 10 天');
    else if (state.reason === 'end') setStatus('已扫描 ' + state.scanned + ' 条卡片，暂无新的可点赞内容');
    else if (state.reason === '') setStatus('已暂停');
    render();
  }

  function stop() {
    state.running = false;
    state.reason = '';
    setStatus('已暂停');
    render();
  }

  /* ---------------- 详情页 ---------------- */
  async function kudoCurrentActivity() {
    const el = document.querySelector('#kudos-comments-container [data-react-props]');
    if (!el) { setStatus('未找到点赞组件，页面结构可能已更新'); return; }
    let p;
    try { p = JSON.parse(el.getAttribute('data-react-props')); } catch (e) { return; }
    if (!p || !p.entityId) return;

    if (p.ownedByCurrentAthlete) { setStatus('这是你自己的活动，无法点赞'); return; }
    if (!p.canKudo) { setStatus('当前不可点赞（已点过或受限）'); return; }

    setStatus('正在点赞活动 ' + p.entityId + '…');
    try {
      await postKudo(p.entityId);
      done['a:' + p.entityId] = Date.now();
      saveDone();
      saveLast({
        type: 'activity',
        who: '',
        title: (document.title || '').replace(/\s*\|.*$/, '').trim(),
        at: Date.now(),
      });
      setStatus('已点赞活动 ' + p.entityId);
      if (startBtn) { startBtn.textContent = '已点赞'; startBtn.disabled = true; }
    } catch (err) {
      setStatus('点赞失败：' + err.message);
    }
  }

  /* ---------------- 评论：一键 @ 回复 ---------------- */
  const REPLY_ATTR = 'data-sak-reply';

  function entryAuthor(entry) {
    const links = entry.querySelectorAll('a[href^="/athletes/"]');
    for (let i = 0; i < links.length; i++) {
      const name = (links[i].textContent || '').trim();
      if (name) return name;
    }
    return '';
  }

  // React 受控组件：必须走原生 setter 再派发 input，否则值会被回滚
  function setTextareaValue(ta, value) {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(ta, value);
    else ta.value = value;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function replyTo(entry) {
    const name = entryAuthor(entry);
    const form = document.querySelector('[data-testid="comments-form"]');
    const ta = form && form.querySelector('textarea');
    if (!ta) { log('未找到评论输入框，请先打开评论弹层'); return; }

    const value = ta.value || '';
    const pos = typeof ta.selectionStart === 'number' ? ta.selectionStart : value.length;
    const pad = pos > 0 && !/\s/.test(value.charAt(pos - 1)) ? ' ' : '';
    const piece = pad + '@' + (name || '') + ' ';
    setTextareaValue(ta, value.slice(0, pos) + piece + value.slice(pos));
    const end = pos + piece.length;
    try { ta.focus(); ta.setSelectionRange(end, end); } catch (e) { ta.focus(); }
    ta.scrollIntoView({ block: 'nearest' });
    log('已填入 @' + (name || ''));
  }

  function decorateComments() {
    const list = document.querySelectorAll('[data-testid="entry"][data-comment-id]');
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (entry.querySelector('[' + REPLY_ATTR + ']')) continue;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute(REPLY_ATTR, '1');
      btn.textContent = '回复';
      btn.style.cssText = 'margin-left:6px;padding:0 7px;height:20px;line-height:18px;border:1px solid #fc5200;' +
        'background:#fff;color:#fc5200;border-radius:5px;font-size:11px;cursor:pointer;vertical-align:middle';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        replyTo(entry);
      });

      const host = entry.querySelector('[data-testid="report-comment-btn"]');
      if (host && host.parentNode) host.parentNode.insertBefore(btn, host);
      else entry.appendChild(btn);
    }
  }

  let replyTimer = null;
  function watchComments() {
    const mo = new MutationObserver(() => {
      if (replyTimer) return;
      replyTimer = setTimeout(() => {
        replyTimer = null;
        try { decorateComments(); } catch (e) { /* 弹层还没渲染好，下次再补 */ }
      }, 300);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    decorateComments();
  }

  /* ---------------- 面板 ---------------- */
  let root, shadow, statusEl, logEl, startBtn, countEl, scanEl;
  let chipRangeEl, chipScopeEl;
  let dockEl, fabEl, flistEl, tipEl;
  const TABS = ['kudos', 'list', 'stats', 'more'];
  const RANGE_LABEL = { today: '今天', '3': '近 3 天', '7': '近 7 天', '10': '近 10 天', all: '不限', custom: '自定义' };
  const LOGO = 'https://d3nn82uaxijpm6.cloudfront.net/apple-touch-icon.png';

  function buildUI() {
    root = document.createElement('div');
    root.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483000;';
    shadow = root.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}

        /* 悬浮球 / 靠边滑条 */
        .dock{position:relative;display:flex;flex-direction:column;align-items:flex-end;width:46px}
        .dock.side-left{align-items:flex-start}
        .fab{position:relative;width:46px;height:46px;border:0;border-radius:50%;background:#fff;padding:0;cursor:pointer;
             box-shadow:0 6px 18px rgba(16,24,40,.22),0 0 0 1px rgba(16,24,40,.06);overflow:hidden;
             transition:width .18s,height .18s,border-radius .18s,background .18s,box-shadow .18s;touch-action:none}
        .fab img{width:100%;height:100%;object-fit:cover;display:block;border-radius:50%;transition:opacity .15s;pointer-events:none}
        .ring{position:absolute;inset:-3px;border-radius:50%;border:2px solid #fc5200;border-top-color:transparent;opacity:0;pointer-events:none}
        .dock.running .ring{opacity:1;animation:spin .9s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        .dock.docked{align-items:flex-end}
        .dock.docked.side-left{align-items:flex-start}
        .dock.docked .fab{width:12px;height:60px;border-radius:6px;background:#fc5200;
                          box-shadow:0 2px 10px rgba(252,82,0,.35)}
        .dock.docked .fab img{opacity:0}
        .dock.docked .ring{display:none}
        .dock.docked:hover .fab,.dock.docked.open .fab{width:46px;height:46px;border-radius:50%;background:#fff;
                                box-shadow:0 6px 18px rgba(16,24,40,.22),0 0 0 1px rgba(16,24,40,.06)}
        .dock.docked:hover .fab img,.dock.docked.open .fab img{opacity:.1}

        /* 圆球悬停变「回到顶部」 */
        .up{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fc5200;
            font-size:19px;font-weight:700;line-height:1;opacity:0;transition:opacity .15s;pointer-events:none}
        .dock:hover .up,.dock.open .up{opacity:1}
        .dock:hover:not(.docked) .fab img,.dock.open:not(.docked) .fab img{opacity:.1}

        /* 环形菜单：4 个扇区平分圆球外围，悬停时弧线变粗 */
        .ringwrap{position:absolute;left:-43px;top:-43px;width:132px;height:132px;pointer-events:none;
                  opacity:0;visibility:hidden;transition:opacity .16s,visibility .16s}
        .ringwrap::before{content:"";position:absolute;inset:0;border-radius:50%;pointer-events:none}
        .dock:hover .ringwrap,.dock.open .ringwrap{opacity:1;visibility:visible;pointer-events:auto}
        .dock:hover .ringwrap::before,.dock.open .ringwrap::before{pointer-events:auto}
        .ringwrap svg{width:132px;height:132px;display:block;pointer-events:none;
                      filter:drop-shadow(0 4px 10px rgba(16,24,40,.16))}
        .seg .hit{fill:none;stroke:transparent;stroke-width:22;pointer-events:stroke;cursor:pointer}
        .seg .vis{fill:none;stroke:#d7dbe0;stroke-width:8;pointer-events:none;transition:stroke .16s,stroke-width .16s}
        .seg:hover .vis{stroke:#fc5200;stroke-width:12}
        .seg.on .vis{stroke:#fc5200;stroke-width:9}
        .seg.on:hover .vis{stroke-width:12}
        .seg.has .vis{stroke:#fdb022}
        .tip{position:absolute;left:50%;top:100%;transform:translate(-50%,2px);white-space:nowrap;
             background:#1c1f23;color:#fff;font-size:11px;line-height:1;padding:5px 9px;border-radius:20px;
             opacity:0;transition:opacity .14s;pointer-events:none}
        .tip.on{opacity:1}
        /* 靠边滑条状态下圆环会超出屏幕，贴边摆放保证四个扇区都能点到 */
        .dock.docked.side-left .ringwrap{left:0}
        .dock.docked:not(.side-left) .ringwrap{left:auto;right:0}

        /* 面板 */
        .panel{position:absolute;right:0;bottom:calc(100% + 50px);width:300px;max-width:calc(100vw - 20px);
               max-height:min(calc(100vh - 200px),560px);overflow:auto;display:none;
               background:#fff;color:#1c1f23;border:1px solid #e6e8eb;border-radius:14px;
               box-shadow:0 10px 30px rgba(16,24,40,.18);font-size:13px}
        .dock.open .panel{display:block}
        .dock.down .panel{top:calc(100% + 50px);bottom:auto}
        .dock.side-left .panel{left:0;right:auto}
        .dock.docked .panel{right:8px}
        .dock.docked.side-left .panel{left:8px;right:auto}
        .head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #eef0f3}
        .dot{width:8px;height:8px;border-radius:50%;background:#c4c9d0;flex:0 0 auto}
        .dot.on{background:#fc5200;box-shadow:0 0 0 3px rgba(252,82,0,.14);animation:bp 1.4s infinite}
        @keyframes bp{50%{opacity:.45}}
        .ttl{font-weight:600;font-size:13px;letter-spacing:.2px;flex:1}
        .tag{font-size:11px;color:#8b929b;background:#f4f6f8;border-radius:20px;padding:2px 8px}
        .icon{width:22px;height:22px;border:0;background:none;color:#9aa1a9;cursor:pointer;font-size:13px;line-height:1;
              border-radius:6px}
        .icon:hover{background:#f4f6f8;color:#4a5058}
        .body{padding:14px}

        /* 组件 */
        .stat{display:flex;align-items:baseline;gap:5px;margin-bottom:10px}
        .num{font-size:28px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
        .unit{font-size:12px;color:#8b929b}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
        .fld label{display:block;font-size:11px;color:#8b929b;margin-bottom:5px}
        .fld input{width:100%;height:32px;border:1px solid #e2e5e9;border-radius:8px;padding:0 9px;font-size:13px;
                   color:#1c1f23;background:#fff;outline:none}
        .fld input:focus{border-color:#fc5200}
        .sel{width:100%;height:32px;border:1px solid #e2e5e9;border-radius:8px;padding:0 8px;font-size:13px;
             color:#1c1f23;background:#fff;outline:none}
        .sel:focus{border-color:#fc5200}
        .dates{display:none;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
        .dates.show{display:grid}
        .dates input{padding:0 6px;font-size:12px}
        .range{display:flex;align-items:center;gap:5px}
        .range input{text-align:center;padding:0 4px}
        .range span{color:#b7bcc3;font-size:11px}
        .switch{display:flex;align-items:center;justify-content:space-between;padding:7px 0;font-size:12px;color:#4a5058}
        .sw{position:relative;width:36px;height:20px;flex:0 0 auto}
        .sw input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:2}
        .sw i{position:absolute;inset:0;background:#dfe3e8;border-radius:20px;transition:.18s}
        .sw i::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;
                     box-shadow:0 1px 2px rgba(0,0,0,.2);transition:.18s}
        .sw input:checked + i{background:#fc5200}
        .sw input:checked + i::after{transform:translateX(16px)}
        .chk{display:flex;align-items:center;gap:7px;padding:5px 0;font-size:12px;color:#4a5058;cursor:pointer}
        .chk input{width:14px;height:14px;accent-color:#fc5200;margin:0;cursor:pointer}
        .grp{background:#fafbfc;border:1px solid #f2f4f6;border-radius:9px;padding:5px 10px;margin:6px 0 10px}
        .grp .chk{padding:4px 0}
        .go{width:100%;height:38px;border:0;border-radius:9px;background:#fc5200;color:#fff;font-size:13px;font-weight:600;
            cursor:pointer;margin-top:12px;transition:.15s}
        .go:hover{background:#e94b00}
        .go.stop{background:#eef0f3;color:#5b6169}
        .sub{display:flex;gap:8px;margin-top:8px}
        .sub button{flex:1;height:30px;border:1px solid #e6e8eb;border-radius:8px;background:#fff;color:#6b7179;
                    font-size:12px;cursor:pointer}
        .sub button:hover{border-color:#cfd4da;color:#1c1f23}
        .sub button:disabled{opacity:.45;cursor:default;border-color:#e6e8eb;color:#6b7179}
        .msg{margin:0 0 12px;font-size:12px;color:#6b7179;line-height:1.5;min-height:18px;word-break:break-word}
        .msg.err{color:#d92d20}
        .msg.ok{color:#12b76a}
        .log{margin-top:10px;border-top:1px solid #f0f2f5;padding-top:8px;max-height:112px;overflow:auto;
             font-size:11px;line-height:1.55;color:#9aa1a9}
        .log div{display:flex;gap:7px}
        .log b{color:#c0c5cc;font-weight:400;font-variant-numeric:tabular-nums;flex:0 0 52px}
        .log span{flex:1;color:#6b7179;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .foot{padding:12px 0 0;margin-top:12px;border-top:1px solid #f5f7f9;font-size:10px;color:#b0b6bd;line-height:1.7}
        .foot a{color:#9aa1a9;text-decoration:none;border-bottom:1px dotted #d7dbe0}
        .foot a:hover{color:#fc5200;border-color:#fc5200}
        .scan{font-size:11px;color:#b0b6bd;margin-top:6px}
        .hint{font-size:11px;color:#b0b6bd;margin:6px 0 8px}
        .pane{display:none}
        .pane.on{display:block}
        .chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
        .chip{font-size:11px;color:#6b7179;background:#f4f6f8;border:1px solid transparent;border-radius:20px;
              padding:3px 9px;cursor:pointer}
        .chip:hover{border-color:#e2e5e9;color:#1c1f23}
        .chip i{font-style:normal;color:#1c1f23;font-weight:600}
        .card{border:1px solid #eef0f3;border-radius:10px;padding:10px;margin-bottom:9px;transition:border-color .2s}
        .card.hl{border-color:#fc5200}
        .card h5{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#4a5058}
        .card h5 .d{width:7px;height:7px;border-radius:50%;background:#fc5200;flex:0 0 auto}
        .card h5 .d.gray{background:#c4c9d0}
        .card h5 .n{margin-left:auto;font-size:11px;color:#9aa1a9;font-weight:400}
        .card h5 .n b{color:#fc5200;font-weight:600}
        .card .sub{margin-top:8px}
        .card textarea{width:100%;height:58px;margin-top:8px;border:1px solid #eef0f3;border-radius:8px;padding:7px 8px;
                       font-size:12px;line-height:1.5;resize:vertical;outline:none;color:#1c1f23;font-family:inherit}
        .card textarea:focus{border-color:#fc5200}

        /* 关注列表：一行一人，右侧三个快捷按钮 */
        .flist{margin-top:8px;max-height:190px;overflow:auto;border-top:1px solid #f2f4f6}
        .frow{display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid #f7f8fa}
        .fname{flex:1;font-size:12px;color:#4a5058;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .fbtns{display:flex;gap:4px;flex:0 0 auto}
        .fbtns button{height:22px;padding:0 7px;border:1px solid #e6e8eb;border-radius:6px;background:#fff;color:#8b929b;
                      font-size:11px;cursor:pointer;font-family:inherit}
        .fbtns button:hover{border-color:#cfd4da;color:#1c1f23}
        .fbtns button.on{background:#fc5200;border-color:#fc5200;color:#fff}
        .fbtns button[data-act="out"]:hover{border-color:#f04438;color:#d92d20}
        .fempty{font-size:11px;color:#b0b6bd;padding:10px 0}

        /* 统计面板 */
        .stabars{display:flex;gap:6px;margin-bottom:12px}
        .stab{flex:1;height:28px;border:1px solid #e6e8eb;border-radius:8px;background:#fff;color:#6b7179;
              font-size:12px;cursor:pointer;font-family:inherit;transition:.15s}
        .stab:hover{border-color:#cfd4da;color:#1c1f23}
        .stab.on{border-color:#fc5200;background:#fff5f0;color:#fc5200;font-weight:600}
        .sview{display:none}
        .sview.on{display:block}
        .kview{display:none}
        .kview.on{display:block}
        .srow{display:flex;align-items:baseline;gap:6px;margin-bottom:10px}
        .srow .num{font-size:26px}
        .srow .unit{font-size:12px;color:#8b929b}
        .smeta{font-size:11px;color:#b0b6bd;margin:0 0 10px;line-height:1.6}
        .slist{max-height:176px;overflow:auto;border-top:1px solid #f2f4f6}
        .sitem{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f7f8fa;font-size:12px}
        .sitem .t{flex:1;color:#4a5058;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .sitem .v{color:#8b929b;font-variant-numeric:tabular-nums;font-size:11px;flex:0 0 auto}
        .sitem .d{color:#b0b6bd;font-size:10px;flex:0 0 auto}
        .sempty{font-size:11px;color:#b0b6bd;padding:10px 0}
        .lastcard{border:1px solid #eef0f3;border-radius:10px;padding:10px;margin-bottom:10px}
        .lastcard .who{font-size:13px;font-weight:600;color:#1c1f23;margin-bottom:3px}
        .lastcard .what{font-size:12px;color:#6b7179;line-height:1.5;word-break:break-word}
        .lastcard .when{font-size:11px;color:#b0b6bd;margin-top:6px}
      </style>

      <div class="dock" id="dock">
        <div class="ringwrap" id="ringwrap">
          <svg viewBox="0 0 132 132" aria-hidden="true">
            <g class="seg" data-tab="kudos" data-label="点赞">
              <path class="hit" d="M19.06 63.54 A47 47 0 0 1 63.54 19.06"></path>
              <path class="vis" d="M19.06 63.54 A47 47 0 0 1 63.54 19.06"></path>
            </g>
            <g class="seg" data-tab="list" data-label="名单">
              <path class="hit" d="M68.46 19.06 A47 47 0 0 1 112.94 63.54"></path>
              <path class="vis" d="M68.46 19.06 A47 47 0 0 1 112.94 63.54"></path>
            </g>
            <g class="seg" data-tab="stats" data-label="分析">
              <path class="hit" d="M112.94 68.46 A47 47 0 0 1 68.46 112.94"></path>
              <path class="vis" d="M112.94 68.46 A47 47 0 0 1 68.46 112.94"></path>
            </g>
            <g class="seg" data-tab="more" data-label="设置">
              <path class="hit" d="M63.54 112.94 A47 47 0 0 1 19.06 68.46"></path>
              <path class="vis" d="M63.54 112.94 A47 47 0 0 1 19.06 68.46"></path>
            </g>
          </svg>
          <div class="tip" id="tip"></div>
        </div>

        <button class="fab" id="fab" type="button" title="回到顶部">
          <img src="${LOGO}" alt="Strava 工具箱">
          <i class="up">↑</i>
          <i class="ring"></i>
        </button>

        <div class="panel" id="panel">
          <div class="head">
            <span class="dot" id="dot"></span>
            <span class="ttl">Strava 工具箱</span>
            <span class="tag" id="tag">待机</span>
            <button class="icon" id="close" type="button" title="关闭">✕</button>
          </div>
          <div class="body">
            <div class="msg" id="msg">准备就绪</div>

            <div class="pane on" data-pane="kudos">
              <div class="stabars">
                <button class="stab on" type="button" data-kview="auto">自动点赞</button>
                <button class="stab" type="button" data-kview="stat">点赞统计</button>
              </div>
              <div class="kview on" data-kview="auto">
              <div class="stat"><span class="num" id="count">0</span><span class="unit" id="unitTxt">已赞</span></div>
              <div class="chips">
                <span class="chip" id="chipRange">范围 <i>近 7 天</i></span>
                <span class="chip" id="chipScope">名单 <i>全部</i></span>
              </div>

              <div class="fld" style="margin-bottom:12px"><label>点赞范围（按活动日期）</label>
                <select class="sel" id="range">
                  <option value="today">今天</option>
                  <option value="3">近 3 天</option>
                  <option value="7">近 7 天</option>
                  <option value="10">近 10 天</option>
                  <option value="all">不限（能加载到的全部）</option>
                  <option value="custom">自定义日期</option>
                </select>
              </div>
              <div class="dates" id="dates">
                <div class="fld"><label>开始日期</label><input id="from" type="date"></div>
                <div class="fld"><label>结束日期</label><input id="to" type="date"></div>
              </div>

              <div class="switch"><span>预览模式（只标记不点赞）</span>
                <label class="sw"><input id="dry" type="checkbox"><i></i></label>
              </div>
              <div class="switch"><span>包含俱乐部动态</span>
                <label class="sw"><input id="club" type="checkbox"><i></i></label>
              </div>

              <button class="go" id="go" type="button">开始自动点赞</button>
              <div class="sub"><button id="again" type="button">继续扫描</button></div>
              <div class="scan" id="scan"></div>
              <div class="log" id="log"></div>
              </div>
              <div class="kview" data-kview="stat">
                <div id="lastBox"></div>
                <div class="smeta" id="lastMeta"></div>
              </div>
            </div>

            <div class="pane" data-pane="list">
              <div class="fld" style="margin:0 0 10px"><label>点赞对象</label>
                <select class="sel" id="scope">
                  <option value="all">全部点赞（忽略名单）</option>
                  <option value="white">只给白名单点赞</option>
                  <option value="black">跳过黑名单</option>
                </select>
              </div>
              <div class="hint" style="margin:-2px 0 10px">白名单：只点这些人；黑名单：跳过这些人；全部：忽略名单。</div>

              <div class="card">
                <h5><span class="d gray" id="fdot"></span>关注列表<span class="n" id="fhint">未载入</span></h5>
                <div class="sub" style="margin-top:0"><button id="follow" type="button">识别关注列表</button></div>
                <div class="flist" id="flist"></div>
              </div>

              <div class="card">
                <h5><span class="d gray" id="wdot"></span>白名单<span class="n"><b id="wc">0</b> 人</span></h5>
                <textarea id="white" placeholder="每行一个名字或 athlete id"></textarea>
              </div>
              <div class="card">
                <h5><span class="d gray" id="bdot"></span>黑名单<span class="n"><b id="bc">0</b> 人</span></h5>
                <textarea id="black" placeholder="每行一个名字或 athlete id"></textarea>
              </div>
            </div>

            <div class="pane" data-pane="stats">
              <div class="stabars">
                <button class="stab on" type="button" data-view="today">今日训练</button>
                <button class="stab" type="button" data-view="member">训练统计</button>
              </div>

              <div class="sview on" data-view="today">
                <div class="srow"><span class="num" id="tCount">0</span><span class="unit">条活动</span></div>
                <div class="srow"><span class="num" id="tDist">0</span><span class="unit">km 总里程</span></div>
                <div class="smeta" id="tMeta">读取当前页面已加载的活动</div>
                <div class="slist" id="tList"></div>
              </div>

              <div class="sview" data-view="member">
                <div class="fld" style="margin-bottom:12px"><label>时间周期</label>
                  <select class="sel" id="sRange">
                    <option value="7">近 7 天</option>
                    <option value="30">近 30 天</option>
                    <option value="all">不限</option>
                  </select>
                </div>
                <div class="srow"><span class="num" id="mCount">0</span><span class="unit">次</span>
                  <span class="num" id="mDist" style="margin-left:16px">0</span><span class="unit">km</span></div>
                <div class="smeta" id="mMeta"></div>
                <div class="slist" id="mList"></div>
              </div>

              <div class="sub"><button id="sRefresh" type="button">刷新统计</button></div>
            </div>

            <div class="pane" data-pane="more">
              <div class="fld" style="margin-bottom:12px"><label>点赞间隔（秒）</label>
                <div class="range">
                  <input id="mind" type="number" min="0.5" step="0.5">
                  <span>–</span>
                  <input id="maxd" type="number" min="0.5" step="0.5">
                </div>
              </div>

              <div class="switch"><span>全部隐藏付费推广</span>
                <label class="sw"><input id="pAll" type="checkbox"><i></i></label>
              </div>
              <div class="grp">
                <label class="chk"><input id="pHeader" type="checkbox">顶部订阅 / 升级按钮</label>
                <label class="chk"><input id="pFeed" type="checkbox">信息流里的推广卡片</label>
                <label class="chk"><input id="pModules" type="checkbox">非会员模块（相对负荷度等）</label>
                <label class="chk"><input id="pFooter" type="checkbox">页脚订阅 / 优惠链接</label>
                <label class="chk"><input id="pText" type="checkbox">其他升级 / 试用文案</label>
              </div>

              <div class="sub"><button id="clear" type="button">清空点赞记录</button></div>
              <div class="foot">
                首页只提供最近约 10 天活动，更早的可以去他人主页点赞。<br>
                v1.5.1 · 作者 <a href="https://www.strava.com/athletes/142433407" target="_blank" rel="noopener">左³</a>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(root);

    const $ = (id) => shadow.getElementById(id);
    statusEl = $('msg');
    logEl = $('log');
    startBtn = $('go');
    countEl = $('count');
    scanEl = $('scan');
    chipRangeEl = $('chipRange');
    chipScopeEl = $('chipScope');
    tipEl = $('tip');
    dockEl = $('dock');
    fabEl = $('fab');
    flistEl = $('flist');

    // buildUI 期间可能就会调用 showTab → refreshStats，统计状态必须提前声明
    const memberState = { rows: [], source: '', req: 0 };
    let statsLoadedId = '';

    /* ---------- 悬浮球：拖动 / 靠边吸附 / 打开面板 ---------- */
    // 圆球默认悬浮，拖到左/右 48px 内自动贴边变成滑条
    let drag = null;
    let suppressClick = false;

    function clamp(n, min, max) {
      return Math.max(min, Math.min(max, n));
    }

    function layoutFab() {
      const f = cfg.fab;
      const docked = !!(f && f.side);
      dockEl.classList.toggle('docked', docked);
      dockEl.classList.toggle('side-left', docked && f.side === 'left');
      if (docked) {
        const y = clamp(Math.round(f.y || innerHeight - 160), 40, innerHeight - 80);
        root.style.left = f.side === 'left' ? '0px' : 'auto';
        root.style.right = f.side === 'right' ? '0px' : 'auto';
        root.style.top = y + 'px';
      } else {
        const x = clamp(Math.round((f && f.x) || innerWidth - 64), 4, innerWidth - 54);
        const y = clamp(Math.round((f && f.y) || innerHeight - 160), 4, innerHeight - 54);
        root.style.left = x + 'px';
        root.style.right = 'auto';
        root.style.top = y + 'px';
      }
    }

    function snapFab() {
      const r = root.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let side = '';
      if (cx < 48) side = 'left';
      else if (innerWidth - cx < 48) side = 'right';
      cfg.fab = side ? { side: side, y: Math.round(cy - 29) } : { x: Math.round(r.left), y: Math.round(r.top) };
      saveCfg();
      layoutFab();
    }

    fabEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { sx: e.clientX, sy: e.clientY, x: root.getBoundingClientRect().left, y: root.getBoundingClientRect().top, moved: false };
      try { fabEl.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });
    fabEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      drag.moved = true;
      dockEl.classList.remove('docked', 'side-left');
      root.style.left = clamp(drag.x + dx, 2, innerWidth - 50) + 'px';
      root.style.right = 'auto';
      root.style.top = clamp(drag.y + dy, 2, innerHeight - 50) + 'px';
    });
    function endDrag() {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (!moved) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 260);
      snapFab();
    }
    fabEl.addEventListener('pointerup', endDrag);
    fabEl.addEventListener('pointercancel', endDrag);

    /* ---------- 面板：同一时间只开一个 ---------- */
    const panes = shadow.querySelectorAll('.pane');
    const segs = shadow.querySelectorAll('.seg');
    function showTab(name) {
      panes.forEach((p) => p.classList.toggle('on', p.getAttribute('data-pane') === name));
      segs.forEach((g) => g.classList.toggle('on', g.getAttribute('data-tab') === name));
      if (cfg.tab !== name) { cfg.tab = name; saveCfg(); }
      if (name === 'stats') refreshStats();
      if (name === 'kudos') renderLast();
    }

    function openPanel(tab) {
      const name = TABS.indexOf(tab) >= 0 ? tab : (TABS.indexOf(cfg.tab) >= 0 ? cfg.tab : 'kudos');
      dockEl.classList.add('open');
      showTab(name);
      // 上下哪边空间大就放哪边，并按剩余空间限制高度，避免面板超出屏幕
      const box = dockEl.getBoundingClientRect();
      const above = box.top;
      const below = innerHeight - box.bottom;
      const up = above >= below;
      dockEl.classList.toggle('down', !up);
      const room = (up ? above : below) - 58;
      $('panel').style.maxHeight = Math.max(200, Math.min(560, room)) + 'px';
    }
    function closePanel() {
      dockEl.classList.remove('open');
    }

    /* 悬停圆球 = 回到顶部 */
    fabEl.addEventListener('click', () => {
      if (suppressClick) return;
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
    });
    $('close').addEventListener('click', closePanel);

    /* 环形扇区：悬停提示名称，点击切换面板 */
    segs.forEach((g) => {
      const t = g.getAttribute('data-tab');
      g.addEventListener('pointerenter', () => {
        tipEl.textContent = g.getAttribute('data-label') || '';
        tipEl.classList.add('on');
      });
      g.addEventListener('pointerleave', () => tipEl.classList.remove('on'));
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        tipEl.classList.remove('on');
        if (dockEl.classList.contains('open') && cfg.tab === t) closePanel();
        else openPanel(t);
      });
    });
    document.addEventListener('pointerdown', (e) => {
      if (!dockEl.classList.contains('open')) return;
      if (e.composedPath().indexOf(root) >= 0) return;
      closePanel();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePanel();
    });
    window.addEventListener('resize', () => { layoutFab(); });

    layoutFab();
    showTab(TABS.indexOf(cfg.tab) >= 0 ? cfg.tab : 'kudos');

    chipRangeEl.addEventListener('click', () => { openPanel('kudos'); $('range').focus(); });
    chipScopeEl.addEventListener('click', () => openPanel('list'));

    /* ---------- 点赞参数 ---------- */
    $('mind').value = cfg.minDelay / 1000;
    $('maxd').value = cfg.maxDelay / 1000;
    $('dry').checked = !!cfg.dryRun;
    $('club').checked = !!cfg.clubPosts;

    const rangeSel = $('range');
    const datesBox = $('dates');
    const isoDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    function syncRangeUI() {
      rangeSel.value = cfg.range;
      datesBox.classList.toggle('show', cfg.range === 'custom');
      $('from').value = cfg.from || '';
      $('to').value = cfg.to || '';
    }
    rangeSel.addEventListener('change', (e) => {
      cfg.range = e.target.value;
      if (cfg.range === 'custom' && !cfg.from && !cfg.to) {
        const now = new Date();
        cfg.from = isoDay(new Date(now.getTime() - 6 * DAY));
        cfg.to = isoDay(now);
      }
      processed.clear();
      saveCfg();
      syncRangeUI();
      render();
    });
    $('from').addEventListener('change', (e) => { cfg.from = e.target.value; processed.clear(); saveCfg(); });
    $('to').addEventListener('change', (e) => { cfg.to = e.target.value; processed.clear(); saveCfg(); });
    syncRangeUI();

    $('mind').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!v) return;
      cfg.minDelay = Math.max(500, Math.round(v * 1000));
      if (cfg.maxDelay < cfg.minDelay) {
        cfg.maxDelay = cfg.minDelay + 2000;
        $('maxd').value = cfg.maxDelay / 1000;
      }
      saveCfg();
    });
    $('maxd').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!v) return;
      cfg.maxDelay = Math.max(cfg.minDelay, Math.round(v * 1000));
      saveCfg();
    });
    $('dry').addEventListener('change', (e) => {
      cfg.dryRun = e.target.checked;
      processed.clear();
      saveCfg();
      render();
    });
    $('club').addEventListener('change', (e) => {
      cfg.clubPosts = e.target.checked;
      processed.clear();
      saveCfg();
    });

    /* ---------- 隐藏付费推广（五类细分） ---------- */
    const promoBox = {
      header: $('pHeader'), feed: $('pFeed'), modules: $('pModules'), footer: $('pFooter'), text: $('pText'),
    };
    function syncPromoUI() {
      PROMO_PARTS.forEach((k) => { promoBox[k].checked = !!cfg.promo[k]; });
      $('pAll').checked = PROMO_PARTS.every((k) => cfg.promo[k]);
    }
    PROMO_PARTS.forEach((k) => {
      promoBox[k].addEventListener('change', (e) => {
        cfg.promo[k] = e.target.checked;
        $('pAll').checked = PROMO_PARTS.every((x) => cfg.promo[x]);
        saveCfg();
        applyPromo();
      });
    });
    $('pAll').addEventListener('change', (e) => {
      const on = e.target.checked;
      PROMO_PARTS.forEach((k) => { cfg.promo[k] = on; });
      syncPromoUI();
      saveCfg();
      applyPromo();
      setStatus(on ? '已全部隐藏推广' : '已恢复全部推广');
    });
    syncPromoUI();

    /* ---------- 名单 ---------- */
    const scopeSel = $('scope');
    scopeSel.value = cfg.scope;
    scopeSel.addEventListener('change', (e) => {
      cfg.scope = e.target.value;
      processed.clear();
      saveCfg();
      render();
    });

    function matches(a, entry) {
      const t = String(entry || '').trim();
      if (!t) return false;
      if (t === a.id) return true;
      return normName(t) === normName(a.name);
    }

    function without(list, a) {
      const out = [];
      list.forEach((v) => { if (!matches(a, v)) out.push(v); });
      return out;
    }

    function markFollowRows() {
      shadow.querySelectorAll('#flist .fbtns button').forEach((b) => {
        const a = (cfg.following || []).find((x) => x.id === b.getAttribute('data-id'));
        if (!a) return;
        const act = b.getAttribute('data-act');
        if (act === 'out') return;
        b.classList.toggle('on', inList(act === 'white' ? cfg.white : cfg.black, a.id, a.name));
      });
    }

    function fillFollowList() {
      const list = cfg.following || [];
      flistEl.textContent = '';
      if (!list.length) {
        const e = document.createElement('div');
        e.className = 'fempty';
        e.textContent = '未载入，点上方按钮识别';
        flistEl.appendChild(e);
      } else {
        list.forEach((a) => {
          const row = document.createElement('div');
          row.className = 'frow';
          const name = document.createElement('span');
          name.className = 'fname';
          name.textContent = a.name;
          name.title = a.name;
          const btns = document.createElement('span');
          btns.className = 'fbtns';
          [['white', '+白'], ['black', '+黑'], ['out', '移出']].forEach((pair) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('data-act', pair[0]);
            b.setAttribute('data-id', a.id);
            b.textContent = pair[1];
            b.title = pair[0] === 'out' ? '从白/黑名单中移除' : '加入' + (pair[0] === 'white' ? '白' : '黑') + '名单';
            btns.appendChild(b);
          });
          row.appendChild(name);
          row.appendChild(btns);
          flistEl.appendChild(row);
        });
      }
      $('fhint').textContent = list.length ? list.length + ' 人' : '未载入';
      markFollowRows();
    }

    flistEl.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = (cfg.following || []).find((x) => x.id === b.getAttribute('data-id'));
      if (!a) return;
      const act = b.getAttribute('data-act');
      if (act === 'out') {
        cfg.white = without(cfg.white, a);
        cfg.black = without(cfg.black, a);
        setStatus('已移出名单：' + a.name, 'ok');
      } else if (inList(act === 'white' ? cfg.white : cfg.black, a.id, a.name)) {
        cfg[act] = without(cfg[act], a);
        setStatus('已从' + (act === 'white' ? '白' : '黑') + '名单移除：' + a.name, 'ok');
      } else {
        const other = act === 'white' ? 'black' : 'white';
        cfg[act] = cfg[act].concat(a.name);
        cfg[other] = without(cfg[other], a);
        setStatus('已加入' + (act === 'white' ? '白' : '黑') + '名单：' + a.name, 'ok');
      }
      processed.clear();
      saveCfg();
      syncLists();
      markFollowRows();
      const card = b.closest('.card');
      if (card) {
        card.classList.add('hl');
        setTimeout(() => card.classList.remove('hl'), 1200);
      }
    });

    function syncLists() {
      const w = $('white');
      const b = $('black');
      if (shadow.activeElement !== w) w.value = cfg.white.join('\n');
      if (shadow.activeElement !== b) b.value = cfg.black.join('\n');
      $('wc').textContent = cfg.white.length;
      $('bc').textContent = cfg.black.length;
      markFollowRows();
      render();
    }

    $('follow').addEventListener('click', async () => {
      const btn = $('follow');
      btn.disabled = true;
      $('fhint').textContent = '正在读取…';
      try {
        const n = await loadFollowing((got) => { $('fhint').textContent = '正在读取 ' + got + ' 人…'; });
        fillFollowList();
        setStatus('已识别 ' + n + ' 位关注，可点右侧按钮加入名单', 'ok');
      } catch (err) {
        if (cfg.following && cfg.following.length) {
          // 刷新失败不影响已有的名单
          fillFollowList();
          setStatus('刷新失败，沿用上次的 ' + cfg.following.length + ' 人', 'err');
        } else {
          $('fhint').textContent = '读取失败';
          setStatus('读取关注列表失败：' + (err.message || err), 'err');
        }
      }
      btn.disabled = false;
    });

    const listTimers = { white: 0, black: 0 };
    function onListInput(key, el) {
      clearTimeout(listTimers[key]);
      listTimers[key] = setTimeout(() => {
        cfg[key] = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
        processed.clear();
        saveCfg();
        $('wc').textContent = cfg.white.length;
        $('bc').textContent = cfg.black.length;
        markFollowRows();
        render();
      }, 300);
    }
    $('white').addEventListener('input', (e) => onListInput('white', e.target));
    $('black').addEventListener('input', (e) => onListInput('black', e.target));
    fillFollowList();
    syncLists();

    /* ---------- 统计面板 ---------- */
    // 信息流卡片上的里程：优先 km / 公里，其次把英里换算成公里
    function cardMeters(card) {
      const txt = card.innerText || '';
      let m = txt.match(/(\d+(?:[.,]\d+)?)\s*(km|公里|千米)/i);
      if (m) return parseFloat(m[1].replace(',', '.'));
      m = txt.match(/(\d+(?:[.,]\d+)?)\s*(mi|英里)/i);
      if (m) return parseFloat(m[1].replace(',', '.')) * 1.60934;
      return null;
    }

    // 当前页面若是运动员主页，返回 {id, name}；否则 null
    function pageAthlete() {
      const m = location.pathname.match(/^\/athletes\/(\d+)/);
      if (!m) return null;
      let name = '';
      const h = document.querySelector('h1');
      if (h) name = String(h.textContent || '').replace(/\s+/g, ' ').trim();
      if (!name) name = String(document.title || '').split('|')[0].trim();
      return { id: m[1], name: name || ('运动员 ' + m[1]) };
    }

    // 取当前页面卡片里某个人的活动（id 为空表示全部）
    function rowsFromCards(id) {
      const out = [];
      const seen = new Set();
      cards().forEach((card) => {
        const a = blockAuthor(card);
        if (id && a.id !== id) return;
        const ids = idsIn(card);
        const aid = ids.size === 1 ? ids.values().next().value : '';
        if (aid) {
          if (seen.has(aid)) return;
          seen.add(aid);
        }
        out.push({
          aid: aid,
          who: a.name || '未知用户',
          id: a.id,
          title: blockTitle(card) || '活动',
          date: cardDate(card),
          km: cardMeters(card),
        });
      });
      return out;
    }

    // 滚到底把懒加载的活动卡片都读出来，读完还原滚动位置
    async function collectCards(id, onStep) {
      const y0 = window.scrollY;
      let stall = 0;
      for (let i = 0; i < 12; i++) {
        const before = cards().length;
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(900);
        if (onStep) onStep(rowsFromCards(id).length);
        if (cards().length === before) {
          if (++stall >= 2) break;
        } else {
          stall = 0;
        }
      }
      window.scrollTo(0, y0);
      await sleep(400);
      return rowsFromCards(id);
    }

    // 自己的训练日志在服务端渲染了 12 周的结构化数据，能拿到准确的日期和里程
    async function selfLogRows() {
      const me = myAthleteId();
      if (!me) return null;
      let res;
      try {
        res = await fetch('/athletes/' + me + '/training/log', { credentials: 'include' });
      } catch (e) { return null; }
      if (!res || !res.ok) return null;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const nd = doc.getElementById('__NEXT_DATA__');
      if (!nd) return null;
      let props;
      try { props = (JSON.parse(nd.textContent) || {}).props || {}; props = props.pageProps || {}; } catch (e) { return null; }
      const entries = (props.entriesResponse && props.entriesResponse.entries) || [];
      const out = [];
      const seen = new Set();
      entries.forEach((en) => {
        const dow = en.by_day_of_week || {};
        Object.keys(dow).forEach((k) => {
          const acts = (dow[k] && dow[k].activities) || [];
          acts.forEach((a) => {
            const aid = String(a.id_str || a.id || '');
            if (aid) {
              if (seen.has(aid)) return;
              seen.add(aid);
            }
            out.push({
              aid: aid,
              who: '我',
              id: me,
              title: a.name || a.type || '活动',
              date: a.start_date ? startOfDay(new Date(a.start_date * 1000)) : null,
              km: typeof a.distance === 'number' ? a.distance / 1000 : null,
            });
          });
        });
      });
      if (!out.length) return null;
      out.sort((a, b) => ((b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0)));
      return out;
    }

    function fmtKm(n) {
      if (!n) return '0';
      return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
    }

    function dayKey(d) {
      if (!d) return '';
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function fillRows(box, rows) {
      box.textContent = '';
      if (!rows.length) {
        const e = document.createElement('div');
        e.className = 'sempty';
        e.textContent = '当前页没有匹配的活动';
        box.appendChild(e);
        return;
      }
      rows.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'sitem';
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = r.title;
        t.title = r.who + ' · ' + r.title;
        const v = document.createElement('span');
        v.className = 'v';
        v.textContent = r.km == null ? '—' : fmtKm(r.km) + ' km';
        const d = document.createElement('span');
        d.className = 'd';
        d.textContent = r.date ? dayKey(r.date).slice(5) : '';
        row.appendChild(t);
        row.appendChild(v);
        row.appendChild(d);
        box.appendChild(row);
      });
    }

    function renderStats() {
      const rows = memberState.rows;
      const today = dayKey(startOfDay(new Date()));
      const tlist = rows.filter((r) => dayKey(r.date) === today);
      let tkm = 0;
      tlist.forEach((r) => { if (r.km) tkm += r.km; });
      $('tCount').textContent = tlist.length;
      $('tDist').textContent = fmtKm(tkm);
      $('tMeta').textContent = memberState.source || '';
      fillRows($('tList'), tlist);

      const range = $('sRange').value || '7';
      const from = range === 'all' ? null : new Date(startOfDay(new Date()).getTime() - (parseInt(range, 10) - 1) * DAY);
      const list = rows.filter((r) => (!from || (r.date && r.date >= from)));
      let km = 0;
      let measured = 0;
      list.forEach((r) => { if (r.km != null) { km += r.km; measured++; } });
      $('mCount').textContent = list.length;
      $('mDist').textContent = fmtKm(km);
      let meta = memberState.source || '';
      if (measured) meta += ' · 平均 ' + fmtKm(km / measured) + ' km/次';
      else if (list.length) meta += ' · 无里程数据';
      $('mMeta').textContent = meta;
      fillRows($('mList'), list);
    }

    function renderLast() {
      const box = $('lastBox');
      const meta = $('lastMeta');
      let rec = null;
      try { rec = JSON.parse(localStorage.getItem(LS_LAST) || 'null'); } catch (e) { rec = null; }
      box.textContent = '';
      if (!rec) {
        const e = document.createElement('div');
        e.className = 'sempty';
        e.textContent = '还没有点赞记录，运行一次自动点赞后会显示在这里';
        box.appendChild(e);
        meta.textContent = '';
        return;
      }
      const card = document.createElement('div');
      card.className = 'lastcard';
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = rec.who || '活动页直接点赞';
      const what = document.createElement('div');
      what.className = 'what';
      what.textContent = rec.title || '活动';
      const when = document.createElement('div');
      when.className = 'when';
      when.textContent = new Date(rec.at).toLocaleString('zh-CN', { hour12: false });
      card.appendChild(who);
      card.appendChild(what);
      card.appendChild(when);
      box.appendChild(card);
      meta.textContent = rec.type === 'post' ? '类型：俱乐部动态' : '类型：活动';
    }

    // 只统计当前主页这个人：自己的走训练日志，别人的读主页已加载的卡片
    async function loadPageStats(deep) {
      const token = ++memberState.req;
      const pg = pageAthlete();
      if (!pg) {
        memberState.rows = [];
        memberState.source = '打开某人的个人主页后，这里会显示 TA 的今日训练和周期统计';
        renderStats();
        return;
      }
      $('mMeta').textContent = '正在读取…';
      if (pg.id === myAthleteId()) {
        const log = await selfLogRows();
        if (token !== memberState.req) return;
        if (log) {
          memberState.rows = log;
          memberState.source = '来自训练日志（近 12 周）';
          renderStats();
          return;
        }
      }
      let rows = deep
        ? await collectCards(pg.id, (n) => { if (token === memberState.req) $('mMeta').textContent = '正在读取… 已 ' + n + ' 条'; })
        : rowsFromCards(pg.id);
      if (token !== memberState.req) return;
      if (deep && !rows.length) {
        // 页面卡片可能要等 React 水合或重新挂载后才出现，稍等再读
        for (let i = 0; i < 3 && !rows.length; i++) {
          await sleep(1500);
          if (token !== memberState.req) return;
          rows = rowsFromCards(pg.id);
        }
      }
      memberState.rows = rows;
      memberState.source = rows.length
        ? '主页已加载的 ' + rows.length + ' 条活动'
        : '页面上还没读到活动，可稍后再点「刷新统计」';
      renderStats();
    }

    function refreshStats(deep) {
      const pg = pageAthlete();
      // 面板打开后第一次进入某人主页会自动抓一轮，之后交给「刷新统计」
      const open = !!(dockEl && dockEl.classList.contains('open'));
      const auto = !!(pg && open && statsLoadedId !== pg.id);
      if (auto) statsLoadedId = pg.id;
      loadPageStats(!!deep || auto);
    }

    $('sRange').addEventListener('change', () => renderStats());
    $('sRefresh').addEventListener('click', () => refreshStats(true));
    shadow.querySelectorAll('.stab[data-view]').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.getAttribute('data-view');
        shadow.querySelectorAll('.stab[data-view]').forEach((x) => x.classList.toggle('on', x === b));
        shadow.querySelectorAll('.sview').forEach((x) => x.classList.toggle('on', x.getAttribute('data-view') === v));
        renderStats();
      });
    });
    shadow.querySelectorAll('.stab[data-kview]').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.getAttribute('data-kview');
        shadow.querySelectorAll('.stab[data-kview]').forEach((x) => x.classList.toggle('on', x === b));
        shadow.querySelectorAll('.kview').forEach((x) => x.classList.toggle('on', x.getAttribute('data-kview') === v));
        if (v === 'stat') renderLast();
      });
    });

    $('again').addEventListener('click', () => {
      if (!state.running) run();
    });
    $('clear').addEventListener('click', () => {
      Object.keys(done).forEach((k) => delete done[k]);
      saveDone();
      processed.clear();
      state.liked = 0;
      state.previewed = 0;
      setStatus('已清空记录');
      render();
    });
    startBtn.addEventListener('click', () => {
      if (state.mode === 'activity') { kudoCurrentActivity(); return; }
      if (state.running) stop();
      else run();
      render();
    });

    render();
    const pgInit = pageAthlete();
    if (pgInit) setStatus('当前页面：' + pgInit.name + '，准备就绪');
  }
  function setStatus(t, kind) {
    if (!statusEl) return;
    statusEl.textContent = t;
    statusEl.className = 'msg' + (kind ? ' ' + kind : '');
    const tag = shadow.getElementById('tag');
    if (tag) tag.textContent = state.running ? '运行中' : (state.mode === 'activity' ? '详情页' : '待机');
    const dot = shadow.getElementById('dot');
    if (dot) dot.classList.toggle('on', state.running);
  }

  function log(t) {
    if (!logEl) return;
    const row = document.createElement('div');
    const time = document.createElement('b');
    time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const text = document.createElement('span');
    text.textContent = t;
    text.title = t;
    row.appendChild(time);
    row.appendChild(text);
    logEl.prepend(row);
    while (logEl.childElementCount > 60) logEl.lastElementChild.remove();
  }

  function render() {
    if (!startBtn) return;
    const count = cfg.dryRun ? state.previewed : state.liked;
    countEl.textContent = count;
    const unitTxt = shadow.getElementById('unitTxt');
    if (unitTxt) unitTxt.textContent = cfg.dryRun ? '已预览' : '已赞';
    if (dockEl) dockEl.classList.toggle('running', state.running);
    startBtn.textContent = state.running ? '暂停' : (state.mode === 'activity' ? '为当前活动点赞' : '开始自动点赞');
    startBtn.classList.toggle('stop', state.running);
    const againBtn = shadow.getElementById('again');
    if (againBtn) againBtn.disabled = state.running;
    if (chipRangeEl) chipRangeEl.innerHTML = '范围 <i>' + (RANGE_LABEL[cfg.range] || '近 7 天') + '</i>';
    if (chipScopeEl) {
      const s = cfg.scope === 'white' ? '白 ' + cfg.white.length + ' 人'
        : cfg.scope === 'black' ? '黑 ' + cfg.black.length + ' 人' : '全部';
      chipScopeEl.innerHTML = '名单 <i>' + s + '</i>';
    }
    // 名单扇区有内容时高亮描边
    const segList = shadow.querySelector('.seg[data-tab="list"]');
    if (segList) segList.classList.toggle('has', cfg.white.length + cfg.black.length > 0);
    // 卡片状态点：有内容才亮，空名单保持灰色
    [['fdot', (cfg.following || []).length], ['wdot', cfg.white.length], ['bdot', cfg.black.length]]
      .forEach((item) => {
        const d = shadow.getElementById(item[0]);
        if (d) d.classList.toggle('gray', !item[1]);
      });
    if (scanEl) {
      const scopeTxt = cfg.scope === 'white' ? ' · 白名单 ' + cfg.white.length + ' 人'
        : cfg.scope === 'black' ? ' · 黑名单 ' + cfg.black.length + ' 人' : '';
      scanEl.textContent = state.scanned
        ? '已扫描 ' + state.scanned + ' 条 · 范围内 ' + state.inRange + ' 条' + scopeTxt
        : '';
    }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    buildUI();
    applyPromo();

    if (isEmbed()) {
      setStatus('嵌入页为只读：只有"查看"链接，没有点赞控件');
      startBtn.disabled = true;
      return;
    }

    watchComments();

    if (isActivityPage()) {
      state.mode = 'activity';
      const el = document.querySelector('#kudos-comments-container [data-react-props]');
      let p = null;
      try { p = el && JSON.parse(el.getAttribute('data-react-props')); } catch (e) { p = null; }
      if (!p) setStatus('未找到点赞组件，可尝试为当前活动点赞');
      else if (p.ownedByCurrentAthlete) setStatus('这是你自己的活动，无法点赞');
      else if (!p.canKudo) setStatus('当前不可点赞（已点过或受限）');
      else setStatus('可点赞，点击下方按钮执行');
      render();
      return;
    }

    if (cfg.autoStart) run();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
