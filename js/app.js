// Экраны приложения и переходы между ними.

import * as db from './db.js';
import { exportBackup, importBackup, BackupError } from './backup.js';
import {
  uid, nowLocal, parseLocal, DATE_RE, fmtDay, fmtDate, fmtTime, fmtSize, plural,
  MONTHS, WEEKDAYS, splitText, mediaKind, canPlayHevc, playableType, sniffHevc, freeSpace,
  thumbFromFile, thumbFromPlayer,
} from './util.js';

const DAY = 24 * 60 * 60 * 1000;
const TRASH_DAYS = 30;
const BACKUP_DAYS = 30;
const PAGE = 60;

const app = document.getElementById('app');
let entries = []; // все записи, включая удалённые (без самих видео и звука)
let notice = null; // строка вверху экрана после действия, например «Запись удалена. Отменить»
let urls = []; // временные ссылки на файлы, которые надо освободить при уходе с экрана
let cleanups = []; // что остановить при уходе с экрана (например, запись голоса)
let renderToken = 0;
let feedLimit = PAGE;
let searchQuery = '';
let searchStar = false;
let searchTags = [];
let calMonth = ''; // «2026-11»
let calDay = ''; // «2026-11-16»
let presetDate = ''; // дата для новой записи, если её начали из календаря
const scrollPos = {};
const thumbs = new Map(); // id видео → обещание ссылки на маленький кадр

const HEVC_HINT = 'На Windows помогает расширение «HEVC Video Extensions» из Microsoft Store.';

// ---------- Мелкие помощники для разметки ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid);
  }
}

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  starFull: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor"/>',
  feed: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<rect x="3" y="7" width="12.5" height="10.5" rx="2.5"/><path d="M15.5 11l5-3v8.5l-5-3z"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5l4.8-4.5 3.2 3 2.6-2.2 4.4 4"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  next: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
};

function icon(name) {
  const s = h('span', { class: 'ic', 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

function btn(label, onclick, cls = '', iconName = null) {
  return h('button', { type: 'button', class: `btn ${cls}`.trim(), onclick }, iconName ? icon(iconName) : null, label);
}

function link(label, hash) {
  return h('a', { href: hash, onclick: (ev) => { ev.preventDefault(); go(hash); } }, label);
}

function confirmDialog(title, text, okLabel, okClass = 'btn-danger-solid') {
  return new Promise((resolve) => {
    const d = h('dialog', { class: 'dlg' });
    const close = (value) => { d.close(); d.remove(); resolve(value); };
    add(d, [
      h('h2', null, title),
      text ? h('p', null, text) : null,
      h('div', { class: 'row' }, btn('Отмена', () => close(false)), btn(okLabel, () => close(true), okClass)),
    ]);
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); close(false); });
    document.body.append(d);
    d.showModal();
  });
}

// ---------- Переходы ----------
// Внизу три постоянных раздела: Лента, Календарь, Поиск.
// Из любого внутреннего экрана «Назад» возвращает туда, откуда пришли.

const TABS = [
  { name: 'feed', hash: '#/', label: 'Лента', icon: 'feed' },
  { name: 'calendar', hash: '#/calendar', label: 'Календарь', icon: 'calendar' },
  { name: 'search', hash: '#/search', label: 'Поиск', icon: 'search' },
];

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return { name: parts[0] || 'feed', id: parts[1] ? decodeURIComponent(parts[1]) : null };
}

function go(hash) {
  scrollPos[location.hash || '#/'] = window.scrollY;
  history.pushState({ d: ((history.state && history.state.d) || 0) + 1 }, '', hash);
  render();
}

// Переключение раздела не копит историю: «Назад» в телефоне не водит по разделам кругами.
function switchTab(hash) {
  scrollPos[location.hash || '#/'] = window.scrollY;
  history.replaceState(history.state || { d: 0 }, '', hash);
  render(scrollPos[hash] || 0);
}

function goBack(parent) {
  if (history.state && history.state.d > 0) {
    history.back();
  } else {
    history.replaceState({ d: 0 }, '', parent);
    render();
  }
}

window.addEventListener('popstate', () => render(scrollPos[location.hash || '#/'] || 0));

function render(scrollTo = 0) {
  renderToken++;
  cleanups.forEach((fn) => { try { fn(); } catch { /* уже остановлено */ } });
  cleanups = [];
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  if (notice && notice.shown) notice = null;
  const r = route();
  if (r.name === 'new') renderEditor(null);
  else if (r.name === 'edit') renderEditor(r.id);
  else if (r.name === 'entry') renderEntry(r.id);
  else if (r.name === 'calendar') renderCalendar();
  else if (r.name === 'search') renderSearch();
  else if (r.name === 'settings') renderSettings();
  else if (r.name === 'trash') renderTrash();
  else renderFeed();
  window.scrollTo(0, scrollTo);
}

// Общий каркас экрана.
// tab — какой раздел подсвечен внизу; fab — кнопка «Новая запись»; bar — одна главная кнопка внутреннего экрана.
function screen({ title, sub, back, actions, body, bar, tab, fab }) {
  app.replaceChildren();
  add(app, [
    h('header', { class: back ? 'top' : 'top top-home' },
      back ? btn('Назад', () => goBack(back), 'btn-quiet back', 'back') : null,
      h('div', { class: 'top-title' }, h('h1', null, title), sub ? h('p', { class: 'muted' }, sub) : null),
      actions ? h('div', { class: 'top-actions' }, actions) : null),
  ]);
  if (notice) {
    const n = notice;
    n.shown = true;
    add(app, [h('p', { class: 'notice', role: 'status' }, n.text + ' ', n.label ? btn(n.label, n.action) : null)]);
  }
  add(app, [h('main', null, body)]);
  if (fab) {
    add(app, [h('button', { type: 'button', class: 'fab', onclick: fab }, icon('plus'), 'Новая запись')]);
  }
  if (tab) {
    add(app, [h('nav', { class: 'tabs', 'aria-label': 'Разделы' }, TABS.map((t) => h('button', {
      type: 'button',
      class: 'tab' + (t.name === tab ? ' tab-on' : ''),
      'aria-current': t.name === tab ? 'page' : null,
      onclick: () => { if (t.name !== tab) switchTab(t.hash); else window.scrollTo(0, 0); },
    }, icon(t.icon), h('span', null, t.label))))]);
  }
  if (bar) add(app, [h('div', { class: 'bar' }, h('div', { class: 'bar-in' }, bar))]);
  document.body.className = bar ? 'has-bar' : tab ? (fab ? 'has-tabs has-fab' : 'has-tabs') : '';
}

function renderMissing() {
  screen({ title: 'Запись не найдена', back: '#/', body: [h('p', null, 'Возможно, она была удалена.')] });
}

// ---------- Данные ----------

function live() {
  return entries
    .filter((e) => !e.deletedAt)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
}

function cache(entry) {
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) entries[i] = entry;
  else entries.push(entry);
}

const tagsOf = (e) => (Array.isArray(e.tags) ? e.tags : []);
const kindOf = (v) => (v.kind === 'audio' ? 'audio' : 'video');

// Все теги, сначала самые частые.
function allTags() {
  const count = new Map();
  for (const e of live()) for (const t of tagsOf(e)) count.set(t, (count.get(t) || 0) + 1);
  return [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b, 'ru'));
}

function draftKey(id) { return 'draft:' + (id || 'new'); }

function loadDraft(id) {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(id)));
    return d && typeof d.text === 'string' && Array.isArray(d.videos) ? d : null;
  } catch {
    return null;
  }
}

function saveDraft(id, d) {
  try { localStorage.setItem(draftKey(id), JSON.stringify(d)); return true; } catch { return false; }
}

function clearDraft(id) {
  try { localStorage.removeItem(draftKey(id)); } catch { /* нечего чистить */ }
}

function getLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function setLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* не страшно */ }
}

function backupDue() {
  const list = live();
  if (!list.length) return false;
  const last = Number(getLocal('lastBackup')) || 0;
  const since = last || Math.min(...list.map((e) => e.createdAt));
  return Date.now() - since > BACKUP_DAYS * DAY;
}

// Маленький кадр видео для ленты. Читается отдельно от самого видео.
function thumbUrl(id) {
  if (!thumbs.has(id)) {
    thumbs.set(id, db.metaGet('thumb:' + id)
      .then((blob) => (blob instanceof Blob ? URL.createObjectURL(blob) : null))
      .catch(() => null));
  }
  return thumbs.get(id);
}

async function saveThumb(id, blob) {
  if (!blob) return;
  try {
    await db.metaSet('thumb:' + id, blob);
    thumbs.set(id, Promise.resolve(URL.createObjectURL(blob)));
  } catch { /* без кадра в ленте можно обойтись */ }
}

// ---------- Карточка записи ----------

function card(e, { fullDate = false, extra = null } = {}) {
  const d = parseLocal(e.date);
  const [title, rest] = splitText(e.text);
  const nVideo = e.videos.filter((v) => kindOf(v) === 'video').length;
  const nAudio = e.videos.length - nVideo;
  const tags = tagsOf(e);

  let thumb = null;
  const firstVideo = e.videos.find((v) => kindOf(v) === 'video');
  if (firstVideo) {
    thumb = h('span', { class: 'c-thumb' }, icon('play'));
    thumbUrl(firstVideo.id).then((url) => {
      if (url) { thumb.style.backgroundImage = `url("${url}")`; thumb.classList.add('c-thumb-img'); }
    });
  }

  const inner = [
    h('span', { class: 'c-date' },
      h('span', { class: 'c-day' }, isNaN(d) ? '?' : String(d.getDate())),
      h('span', { class: 'c-wd' }, isNaN(d) ? '' : WEEKDAYS[d.getDay()])),
    h('span', { class: 'c-body' },
      title ? h('span', { class: 'c-title' }, title.slice(0, 200)) : null,
      rest ? h('span', { class: 'c-text' }, rest.slice(0, 300)) : null,
      h('span', { class: 'c-meta' },
        e.starred ? h('span', { class: 'c-star' }, icon('starFull')) : null,
        h('span', null, fullDate ? `${fmtDate(e.date)}, ${fmtTime(e.date)}` : fmtTime(e.date)),
        nVideo ? h('span', { class: 'c-kind' }, icon('play'), nVideo > 1 ? `${nVideo} видео` : 'видео') : null,
        nAudio ? h('span', { class: 'c-kind' }, icon('mic'), nAudio > 1 ? `${nAudio} голос.` : 'голос') : null),
      tags.length ? h('span', { class: 'c-tags' }, tags.map((t) => h('span', { class: 'tag' }, t))) : null),
    thumb,
  ];

  if (extra) return h('div', { class: 'card card-static' }, h('div', { class: 'card-row' }, inner), extra);
  return h('a', {
    class: 'card card-row',
    href: '#/entry/' + e.id,
    onclick: (ev) => { ev.preventDefault(); go('#/entry/' + e.id); },
  }, inner);
}

// ---------- Лента ----------

function renderFeed() {
  const list = live();
  const body = [];

  if (backupDue()) {
    body.push(h('p', { class: 'line' }, 'Резервной копии не было больше 30 дней. ', link('Сделать копию', '#/settings')));
  }
  if (loadDraft(null)) {
    body.push(h('p', { class: 'line' }, 'Есть несохранённый черновик. ', link('Продолжить', '#/new')));
  }

  const today = nowLocal();
  const sameDay = list.filter((e) => e.date.slice(5, 10) === today.slice(5, 10) && e.date.slice(0, 4) < today.slice(0, 4));
  if (sameDay.length) {
    body.push(h('section', { class: 'memory' },
      h('h2', null, 'В этот день'),
      sameDay.map((e) => card(e, { fullDate: true }))));
  }

  if (!list.length) {
    body.push(h('div', { class: 'empty' },
      h('p', { class: 'empty-title' }, 'Здесь будут ваши записи'),
      h('p', null, 'Нажмите «Новая запись» внизу экрана.')));
  }

  let month = null;
  for (const e of list.slice(0, feedLimit)) {
    const key = e.date.slice(0, 7);
    if (key !== month) {
      month = key;
      body.push(h('h2', { class: 'month' }, `${MONTHS[Number(key.slice(5, 7)) - 1] || ''} ${key.slice(0, 4)}`));
    }
    body.push(card(e));
  }
  if (list.length > feedLimit) {
    body.push(btn('Показать ещё', () => { feedLimit += PAGE; render(window.scrollY); }, 'wide'));
  }

  screen({
    title: 'Дневник',
    actions: [h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => go('#/settings') }, icon('gear'), 'Настройки')],
    body,
    tab: 'feed',
    fab: () => { presetDate = ''; go('#/new'); },
  });
}

// ---------- Календарь ----------

function renderCalendar() {
  const today = nowLocal().slice(0, 10);
  if (!calMonth) { calMonth = today.slice(0, 7); calDay = today; }
  const y = Number(calMonth.slice(0, 4));
  const m = Number(calMonth.slice(5, 7));
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // неделя начинается с понедельника
  const list = live();
  const count = new Map();
  for (const e of list) {
    if (e.date.startsWith(calMonth)) count.set(e.date.slice(0, 10), (count.get(e.date.slice(0, 10)) || 0) + 1);
  }

  const shift = (step) => {
    const d = new Date(y, m - 1 + step, 1);
    calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    calDay = calMonth === today.slice(0, 7) ? today : '';
    render(window.scrollY);
  };

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h('span', { class: 'cal-gap' }));
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${calMonth}-${String(day).padStart(2, '0')}`;
    const n = count.get(key) || 0;
    cells.push(h('button', {
      type: 'button',
      class: 'cal-day' + (key === today ? ' cal-today' : '') + (key === calDay ? ' cal-sel' : '') + (n ? ' cal-has' : ''),
      'aria-pressed': String(key === calDay),
      'aria-label': `${fmtDate(key + 'T00:00')}, записей: ${n}`,
      onclick: () => { calDay = key; render(window.scrollY); },
    }, h('span', null, String(day)), h('span', { class: 'cal-dot' })));
  }

  const dayEntries = calDay ? list.filter((e) => e.date.startsWith(calDay)) : [];

  screen({
    title: 'Календарь',
    body: [
      h('div', { class: 'cal-head' },
        h('button', { type: 'button', class: 'btn btn-square', 'aria-label': 'Предыдущий месяц', onclick: () => shift(-1) }, icon('back')),
        h('h2', null, `${MONTHS[m - 1]} ${y}`),
        h('button', { type: 'button', class: 'btn btn-square', 'aria-label': 'Следующий месяц', onclick: () => shift(1) }, icon('next'))),
      h('div', { class: 'cal-grid cal-week', 'aria-hidden': 'true' }, ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((w) => h('span', null, w))),
      h('div', { class: 'cal-grid' }, cells),
      calMonth !== today.slice(0, 7)
        ? h('div', { class: 'row' }, btn('К сегодняшнему дню', () => { calMonth = today.slice(0, 7); calDay = today; render(); }))
        : null,
      calDay
        ? [h('h2', { class: 'month' }, fmtDay(calDay + 'T00:00')),
          dayEntries.length ? dayEntries.map((e) => card(e)) : h('p', { class: 'muted' }, 'В этот день записей нет.')]
        : h('p', { class: 'muted' }, 'Выберите день. Точкой отмечены дни с записями.'),
    ],
    tab: 'calendar',
    fab: () => {
      // Новая запись из календаря получает выбранный день и текущее время.
      presetDate = calDay && calDay !== today ? `${calDay}T${nowLocal().slice(11, 16)}` : '';
      go('#/new');
    },
  });
}

// ---------- Поиск ----------

function renderSearch() {
  const results = h('div');
  const input = h('input', { type: 'search', id: 'f-search', value: searchQuery, autocomplete: 'off', enterkeyhint: 'search', placeholder: 'Слово или фраза' });
  const tags = allTags();
  searchTags = searchTags.filter((t) => tags.includes(t));
  const filters = h('div', { class: 'chips' });

  function drawFilters() {
    filters.replaceChildren();
    add(filters, [
      h('button', {
        type: 'button', class: 'chip' + (searchStar ? ' chip-on' : ''), 'aria-pressed': String(searchStar),
        onclick: () => { searchStar = !searchStar; drawFilters(); draw(); },
      }, icon(searchStar ? 'starFull' : 'star'), 'Избранное'),
      tags.map((t) => h('button', {
        type: 'button', class: 'chip' + (searchTags.includes(t) ? ' chip-on' : ''), 'aria-pressed': String(searchTags.includes(t)),
        onclick: () => {
          searchTags = searchTags.includes(t) ? searchTags.filter((x) => x !== t) : [...searchTags, t];
          drawFilters();
          draw();
        },
      }, t)),
    ]);
  }

  function draw() {
    const q = searchQuery.trim().toLowerCase();
    results.replaceChildren();
    if (!q && !searchStar && !searchTags.length) return;
    const found = live().filter((e) => (!q || e.text.toLowerCase().includes(q) || tagsOf(e).some((t) => t.toLowerCase().includes(q)))
      && (!searchStar || e.starred)
      && searchTags.every((t) => tagsOf(e).includes(t)));
    if (!found.length) {
      add(results, [h('p', { class: 'muted' }, 'Ничего не найдено.')]);
      return;
    }
    add(results, [
      h('p', { class: 'muted' }, 'Найдено: ' + plural(found.length, 'запись', 'записи', 'записей')),
      found.slice(0, 200).map((e) => card(e, { fullDate: true })),
    ]);
  }

  input.addEventListener('input', () => { searchQuery = input.value; draw(); });
  screen({
    title: 'Поиск',
    body: [
      h('label', { for: 'f-search', class: 'sr' }, 'Слово или фраза из записи'),
      input,
      filters,
      results,
    ],
    tab: 'search',
  });
  drawFilters();
  draw();
}

// ---------- Просмотр записи ----------

function renderEntry(id) {
  const e = entries.find((x) => x.id === id);
  if (!e || e.deletedAt) { renderMissing(); return; }
  const token = renderToken;
  const media = e.videos.map((v, i) => {
    const box = h('div', { class: 'media' }, h('p', { class: 'muted' }, 'Открываю…'));
    showMedia(v, e.videos.filter((x, j) => j <= i && kindOf(x) === kindOf(v)).length, box, token);
    return box;
  });
  const [title, rest] = splitText(e.text);
  const tags = tagsOf(e);

  async function toggleStar() {
    const next = { ...e, starred: !e.starred, updatedAt: Date.now() };
    try {
      await db.putEntry(next);
      cache(next);
    } catch {
      notice = { text: 'Не получилось изменить отметку.' };
    }
    render(window.scrollY);
  }

  screen({
    title: fmtDate(e.date),
    sub: `${fmtDay(e.date).split(',')[0]}, ${fmtTime(e.date)}`,
    back: '#/',
    actions: [h('button', {
      type: 'button', class: 'btn btn-quiet' + (e.starred ? ' star-on' : ''), 'aria-pressed': String(!!e.starred), onclick: toggleStar,
    }, icon(e.starred ? 'starFull' : 'star'), e.starred ? 'В избранном' : 'В избранное')],
    body: [
      tags.length ? h('div', { class: 'chips' }, tags.map((t) => h('span', { class: 'tag' }, t))) : null,
      title ? h('h2', { class: 'entry-title' }, title) : null,
      rest ? h('div', { class: 'text' }, rest) : null,
      media,
      h('div', { class: 'row end' }, btn('Удалить запись', () => removeEntry(e), 'btn-danger')),
    ],
    bar: [btn('Изменить', () => go('#/edit/' + e.id), 'btn-primary wide')],
  });
}

async function showMedia(v, number, box, token) {
  const kind = kindOf(v);
  const word = kind === 'audio' ? 'Голос' : 'Видео';
  let blob = null;
  try { blob = await db.getVideoBlob(v.id); } catch { /* покажем сообщение ниже */ }
  if (token !== renderToken) return;
  if (!blob) {
    box.replaceChildren(h('p', { class: 'warn' }, 'Этот файл не найден на устройстве.'));
    return;
  }
  const type = playableType(v);
  const url = URL.createObjectURL(blob.slice(0, blob.size, type));
  urls.push(url);
  // Сначала пробуем адрес, который обслуживает sw.js (так надёжнее на айфоне), потом прямую ссылку.
  const sources = [url];
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    sources.unshift(`__video/${encodeURIComponent(v.id)}?type=${encodeURIComponent(type)}${kind === 'video' ? '#t=0.001' : ''}`);
  }
  let attempt = 0;
  const player = kind === 'audio'
    ? h('audio', { controls: true, preload: 'metadata', src: sources[0] })
    : h('video', { controls: true, playsinline: true, preload: 'metadata', src: sources[0] });
  const info = h('p', { class: 'muted' }, `${word} ${number} · ${fmtSize(v.size)} · `,
    h('a', { href: url, download: v.name || (kind === 'audio' ? 'voice' : 'video') }, 'Сохранить файл'));
  // Плеер показывается всегда. Сообщение появляется, только если файл не открылся или может не открыться.
  const hint = v.hevc && !canPlayHevc()
    ? h('p', { class: 'warn' }, `Это видео снято на айфон в формате HEVC. Если оно не показывается или идёт без картинки — файл цел. ${HEVC_HINT}`)
    : null;
  player.addEventListener('error', () => {
    const code = player.error ? player.error.code : 0;
    attempt++;
    if (attempt < sources.length) {
      player.src = sources[attempt];
      player.load();
      return;
    }
    if (hint) hint.remove();
    player.replaceWith(h('p', { class: 'warn' }, (v.hevc && !canPlayHevc()
      ? `Это видео снято на айфон в формате HEVC, и это устройство его не показывает. Файл цел. ${HEVC_HINT}`
      : 'Этот файл не открывается на этом устройстве. Он цел: его можно сохранить и открыть другой программой.')
      + ` (Код ошибки: ${code}.)`));
  });
  if (kind === 'video') {
    // Если у старого видео ещё нет кадра для ленты, берём его из плеера.
    player.addEventListener('loadeddata', async () => {
      if (await thumbUrl(v.id)) return;
      saveThumb(v.id, await thumbFromPlayer(player));
    }, { once: true });
  }
  box.replaceChildren();
  add(box, [player, info, hint]);
}

async function removeEntry(e) {
  const ok = await confirmDialog('Удалить эту запись?', `Её можно вернуть в течение ${TRASH_DAYS} дней: Настройки → Удалённые записи.`, 'Удалить');
  if (!ok) return;
  const now = Date.now();
  const gone = { ...e, deletedAt: now, updatedAt: now };
  try {
    await db.putEntry(gone);
  } catch {
    notice = { text: 'Не получилось удалить запись. Она осталась на месте.' };
    render();
    return;
  }
  cache(gone);
  clearDraft(e.id);
  notice = { text: 'Запись удалена.', label: 'Отменить', action: () => restoreEntry(gone) };
  goBack('#/');
}

async function restoreEntry(e) {
  const back = { ...e, updatedAt: Date.now() };
  delete back.deletedAt;
  try {
    await db.putEntry(back);
    cache(back);
    notice = { text: 'Запись возвращена.' };
  } catch {
    notice = { text: 'Не получилось вернуть запись. Она лежит в удалённых.' };
  }
  render();
}

// ---------- Новая запись и изменение ----------

function renderEditor(id) {
  const existing = id ? entries.find((e) => e.id === id && !e.deletedAt) : null;
  if (id && !existing) { renderMissing(); return; }

  const saved = loadDraft(id);
  const d = saved
    ? { date: String(saved.date || ''), text: saved.text, videos: saved.videos, tags: Array.isArray(saved.tags) ? saved.tags : [] }
    : existing
      ? { date: existing.date, text: existing.text, videos: existing.videos.slice(), tags: tagsOf(existing).slice() }
      : { date: presetDate || nowLocal(), text: '', videos: [], tags: [] };
  if (!id) presetDate = '';
  let busy = false;
  let recording = null;

  const status = h('p', { class: 'muted status', role: 'status' }, saved ? 'Черновик восстановлен.' : '');
  const error = h('p', { class: 'warn', role: 'alert', hidden: true });
  const mediaList = h('div', { class: 'attached' });
  const recorder = h('div', { class: 'recorder', hidden: true });
  const tagBox = h('div', { class: 'chips' });
  const discard = btn('Удалить черновик', discardDraft, 'btn-danger');
  const saveBtn = btn('Сохранить', save, 'btn-primary wide');

  const sameMedia = () => existing && d.videos.length === existing.videos.length && d.videos.every((v, i) => v.id === existing.videos[i].id);
  const changed = () => (existing
    ? d.date !== existing.date || d.text !== existing.text || !sameMedia() || d.tags.join('\n') !== tagsOf(existing).join('\n')
    : d.text.trim() !== '' || d.videos.length > 0 || d.tags.length > 0);

  function say(text) {
    error.textContent = text || '';
    error.hidden = !text;
  }

  // Черновик пишется при каждом изменении, сразу и без таймеров.
  function keep() {
    if (changed()) {
      status.textContent = saveDraft(id, d) ? 'Черновик сохранён.' : 'Черновик не сохраняется: в браузере нет места.';
    } else {
      clearDraft(id);
      status.textContent = '';
    }
    discard.hidden = !changed();
  }

  function drawMedia() {
    mediaList.replaceChildren();
    let nv = 0;
    let na = 0;
    d.videos.forEach((v, i) => {
      const audio = kindOf(v) === 'audio';
      const label = audio ? `Голос ${++na}` : `Видео ${++nv}`;
      add(mediaList, [h('div', { class: 'attached-row' },
        h('span', { class: 'attached-name' }, icon(audio ? 'mic' : 'play'), `${label} · ${fmtSize(v.size)}`),
        btn('Убрать', () => {
          if (busy) return;
          d.videos.splice(i, 1);
          // Файл из уже сохранённой записи стирается только после «Сохранить».
          if (!existing || !existing.videos.some((x) => x.id === v.id)) db.deleteVideos([v.id]).catch(() => {});
          keep();
          drawMedia();
        }))]);
    });
  }

  function drawTags() {
    const known = allTags();
    const all = [...d.tags, ...known.filter((t) => !d.tags.includes(t))];
    tagBox.replaceChildren();
    add(tagBox, all.map((t) => h('button', {
      type: 'button', class: 'chip' + (d.tags.includes(t) ? ' chip-on' : ''), 'aria-pressed': String(d.tags.includes(t)),
      onclick: () => {
        d.tags = d.tags.includes(t) ? d.tags.filter((x) => x !== t) : [...d.tags, t];
        keep();
        drawTags();
      },
    }, t)));
    tagBox.hidden = !all.length;
  }

  function addTag() {
    const t = tagInput.value.trim().replace(/^#+/, '').slice(0, 40);
    tagInput.value = '';
    if (!t) return;
    const same = [...d.tags, ...allTags()].find((x) => x.toLowerCase() === t.toLowerCase()) || t;
    if (!d.tags.includes(same)) d.tags = [...d.tags, same];
    keep();
    drawTags();
  }

  function setBusy(on, text) {
    busy = on;
    saveBtn.disabled = on;
    for (const b of pickers) b.disabled = on;
    if (text !== undefined) status.textContent = text;
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || busy) return;
    say('');
    const problems = [];
    let hevcWarn = false;
    setBusy(true);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const kind = mediaKind(file);
      if (!kind) { problems.push(`«${file.name}» — это не видео и не звук, файл пропущен.`); continue; }
      const what = kind === 'audio' ? 'запись голоса' : 'видео';
      status.textContent = files.length > 1 ? `Сохраняю файл ${i + 1} из ${files.length}…` : `Сохраняю ${what}…`;
      const free = await freeSpace();
      if (free !== null && file.size > free) {
        problems.push(`Не хватает места: нужно ${fmtSize(file.size)}, свободно примерно ${fmtSize(free)}. Файл не добавлен. Текст записи цел.`);
        continue;
      }
      const vid = uid();
      try {
        await db.putVideo(vid, file);
      } catch (err) {
        problems.push(db.isQuotaError(err)
          ? `Не хватило места, файл (${fmtSize(file.size)}) не добавлен. Текст записи цел. Освободите место на устройстве и попробуйте снова.`
          : 'Файл не сохранился. Текст записи цел. Попробуйте добавить его ещё раз.');
        continue;
      }
      const item = { id: vid, kind, name: file.name || kind, type: (file.type || '').split(';')[0], size: file.size, hevc: false };
      d.videos.push(item);
      saveDraft(id, d);
      drawMedia();
      if (kind === 'video') {
        item.hevc = await sniffHevc(file);
        if (item.hevc && !canPlayHevc()) hevcWarn = true;
        saveDraft(id, d);
        await saveThumb(vid, await thumbFromFile(file, playableType(item)));
      }
    }
    setBusy(false, '');
    keep();
    if (hevcWarn) problems.push(`Видео сохранено, но оно в формате HEVC (так снимает айфон), и это устройство может его не показать. ${HEVC_HINT}`);
    say(problems.join(' '));
  }

  // --- Запись голоса ---

  function stopStream() {
    if (!recording) return;
    clearInterval(recording.timer);
    recording.stream.getTracks().forEach((t) => t.stop());
  }

  async function startVoice() {
    if (busy || recording) return;
    say('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      audioInput.click(); // запасной путь: выбрать готовый звуковой файл
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      say('Нет доступа к микрофону. Разрешите его для «Дневника» в настройках телефона или браузера и попробуйте снова.');
      return;
    }
    const failed = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recording) clearInterval(recording.timer);
      recording = null;
      recorder.hidden = true;
      setBusy(false);
      say('Не получилось начать запись голоса на этом устройстве. Текст записи цел.');
    };
    let rec;
    try {
      rec = new MediaRecorder(stream);
    } catch {
      failed();
      return;
    }
    const chunks = [];
    const started = Date.now();
    const clock = h('span', null, '0:00');
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recording = {
      stream,
      rec,
      cancelled: false,
      timer: setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 1000),
    };
    rec.onstop = () => {
      const r = recording;
      stopStream();
      recording = null;
      recorder.hidden = true;
      setBusy(false);
      if (!r || r.cancelled || !chunks.length) return;
      const type = (rec.mimeType || chunks[0].type || 'audio/mp4').split(';')[0];
      const ext = type.includes('webm') ? 'webm' : type.includes('ogg') ? 'ogg' : 'm4a';
      addFiles([new File(chunks, `voice.${ext}`, { type })]);
    };
    recorder.replaceChildren();
    add(recorder, [
      h('p', null, icon('mic'), 'Идёт запись голоса · ', clock),
      h('div', { class: 'row' },
        btn('Остановить и сохранить', () => rec.stop(), 'btn-primary'),
        btn('Отменить', () => { recording.cancelled = true; rec.stop(); })),
    ]);
    recorder.hidden = false;
    setBusy(true);
    try {
      rec.start(1000);
    } catch {
      failed();
    }
  }

  // Если уйти с экрана во время записи голоса, микрофон выключается.
  cleanups.push(() => {
    if (!recording) return;
    recording.cancelled = true;
    stopStream();
    try { recording.rec.stop(); } catch { /* уже остановлена */ }
  });

  async function save() {
    if (busy) return;
    say('');
    if (!DATE_RE.test(d.date)) { say('Укажите дату и время.'); return; }
    if (d.text.trim() === '' && d.videos.length === 0) { say('Запись пустая. Напишите текст, снимите видео или запишите голос.'); return; }
    const now = Date.now();
    const videos = d.videos.map((v) => ({ id: v.id, kind: kindOf(v), name: v.name, type: v.type, size: v.size, hevc: !!v.hevc }));
    const entry = existing
      ? { ...existing, date: d.date, text: d.text, tags: d.tags, videos, updatedAt: now }
      : { id: uid(), date: d.date, text: d.text, tags: d.tags, starred: false, videos, createdAt: now, updatedAt: now };
    setBusy(true);
    try {
      await db.putEntry(entry);
    } catch (err) {
      setBusy(false);
      say(db.isQuotaError(err)
        ? 'Запись не сохранилась: на устройстве закончилось место. Текст не потерян, он остался в черновике. Освободите место и нажмите «Сохранить» ещё раз.'
        : 'Запись не сохранилась. Текст не потерян, он остался в черновике. Нажмите «Сохранить» ещё раз.');
      return;
    }
    cache(entry);
    clearDraft(id);
    if (existing) {
      const keepIds = new Set(videos.map((v) => v.id));
      const gone = existing.videos.filter((v) => !keepIds.has(v.id)).map((v) => v.id);
      try { await db.deleteVideos(gone); } catch { /* уберётся при следующем запуске */ }
    }
    notice = { text: 'Запись сохранена.' };
    goBack(existing ? '#/entry/' + existing.id : '#/');
  }

  async function discardDraft() {
    if (busy) return;
    const ok = await confirmDialog('Удалить черновик?', existing ? 'Запись останется такой, какой была до изменений.' : 'Текст, видео и голос из черновика будут удалены.', 'Удалить черновик');
    if (!ok) return;
    const keepIds = new Set(existing ? existing.videos.map((v) => v.id) : []);
    const extra = d.videos.filter((v) => !keepIds.has(v.id)).map((v) => v.id);
    clearDraft(id);
    try { await db.deleteVideos(extra); } catch { /* уберётся при следующем запуске */ }
    goBack(existing ? '#/entry/' + existing.id : '#/');
  }

  const dateInput = h('input', { type: 'datetime-local', id: 'f-date', value: d.date });
  dateInput.addEventListener('input', () => { d.date = dateInput.value.slice(0, 16); keep(); });

  const textInput = h('textarea', { id: 'f-text', rows: '7', value: d.text, placeholder: 'Первая строка станет заголовком' });
  const grow = () => { textInput.style.height = 'auto'; textInput.style.height = textInput.scrollHeight + 2 + 'px'; };
  textInput.addEventListener('input', () => { d.text = textInput.value; keep(); grow(); });

  const tagInput = h('input', { type: 'text', id: 'f-tag', autocomplete: 'off', autocapitalize: 'none', enterkeyhint: 'done', placeholder: 'Новый тег' });
  tagInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addTag(); } });

  const cameraInput = h('input', { type: 'file', accept: 'video/*', capture: 'environment', hidden: true });
  const fileInput = h('input', { type: 'file', accept: 'video/*,.mov,.mp4,.m4v,.webm', multiple: true, hidden: true });
  const audioInput = h('input', { type: 'file', accept: 'audio/*', hidden: true });
  for (const input of [cameraInput, fileInput, audioInput]) {
    input.addEventListener('change', () => { const files = Array.from(input.files); input.value = ''; addFiles(files); });
  }
  // «Снять» открывает камеру только на телефоне, поэтому на компьютере этой кнопки нет.
  const isPhone = window.matchMedia('(pointer: coarse)').matches;
  const pickers = [
    isPhone ? btn('Снять видео', () => cameraInput.click(), '', 'camera') : null,
    btn(isPhone ? 'Из галереи' : 'Выбрать файл', () => fileInput.click(), '', 'image'),
    btn('Записать голос', startVoice, '', 'mic'),
  ].filter(Boolean);

  screen({
    title: existing ? 'Изменение записи' : 'Новая запись',
    back: existing ? '#/entry/' + existing.id : '#/',
    body: [
      h('label', { for: 'f-date' }, 'Дата и время'),
      dateInput,
      h('label', { for: 'f-text' }, 'Текст'),
      textInput,
      h('p', { class: 'label' }, 'Видео и голос'),
      mediaList,
      recorder,
      h('div', { class: 'row' }, pickers, cameraInput, fileInput, audioInput),
      h('label', { for: 'f-tag' }, 'Теги'),
      tagBox,
      h('div', { class: 'tag-add' }, tagInput, btn('Добавить', addTag)),
      error,
      status,
      h('div', { class: 'row end' }, discard),
    ],
    bar: [saveBtn],
  });
  drawMedia();
  drawTags();
  discard.hidden = !changed();
  grow();
}

// ---------- Настройки ----------

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  setLocal('theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f5f3ef' : '#171b20';
}

function renderSettings() {
  const token = renderToken;
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const themeBtn = (value, label) => h('button', {
    type: 'button',
    class: 'btn' + (theme === value ? ' btn-on' : ''),
    'aria-pressed': String(theme === value),
    onclick: () => { setTheme(value); render(window.scrollY); },
  }, label);

  // Место
  const space = h('p', null, 'Считаю…');
  const guard = h('p', { class: 'muted' });
  (async () => {
    let text = 'Браузер не сообщает, сколько места занято.';
    try {
      const { usage, quota } = await navigator.storage.estimate();
      text = `Занято ${fmtSize(usage)} из примерно ${fmtSize(quota)}, которые телефон даёт приложению.`;
    } catch { /* оставим текст по умолчанию */ }
    let kept = false;
    try { kept = await navigator.storage.persisted(); } catch { /* не поддерживается */ }
    if (token !== renderToken) return;
    space.textContent = text;
    guard.textContent = kept
      ? 'Защита от автоочистки включена: записи не удалятся сами.'
      : 'Защита от автоочистки не включена. Обычно она включается после установки приложения на экран «Домой». Резервная копия защищает в любом случае.';
  })();

  // Резервная копия
  const last = Number(getLocal('lastBackup')) || 0;
  const lastLine = h('p', { class: 'muted' }, last ? `Последняя копия: ${fmtDate(last)}.` : 'Копия ещё не делалась.');
  const backupStatus = h('p', { role: 'status', hidden: true });
  const backupResult = h('div');
  const importInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  let working = false;

  const say = (text) => { backupStatus.textContent = text || ''; backupStatus.hidden = !text; };

  async function makeBackup() {
    if (working) return;
    working = true;
    backupResult.replaceChildren();
    say('Готовлю копию…');
    try {
      const res = await exportBackup(entries, (n, total) => say(`Готовлю копию: файл ${n} из ${total}…`));
      if (token !== renderToken) return;
      say(`Копия готова: ${plural(res.entries, 'запись', 'записи', 'записей')}, видео и голос: ${res.videos}, размер ${fmtSize(res.file.size)}.`
        + (res.missing ? ` Не найдено файлов: ${res.missing}.` : ''));
      add(backupResult, [
        btn('Сохранить файл копии', () => saveFile(res.file), 'btn-primary'),
        h('p', { class: 'muted' }, 'Положите файл туда, где он не потеряется: в iCloud Drive, в облако или на компьютер.'),
      ]);
    } catch {
      if (token === renderToken) say('Не получилось подготовить копию. Записи не тронуты. Попробуйте ещё раз.');
    } finally {
      working = false;
    }
  }

  async function saveFile(file) {
    const done = () => {
      setLocal('lastBackup', String(Date.now()));
      lastLine.textContent = `Последняя копия: ${fmtDate(Date.now())}.`;
    };
    const isPhone = window.matchMedia('(pointer: coarse)').matches;
    if (isPhone && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        done();
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // человек сам закрыл окно
      }
    }
    const url = URL.createObjectURL(file);
    urls.push(url);
    const a = h('a', { href: url, download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    done();
  }

  async function loadBackup(file) {
    if (working || !file) return;
    working = true;
    backupResult.replaceChildren();
    say('Читаю копию…');
    try {
      const res = await importBackup(file, entries, (n, total) => say(`Загружаю записи: ${n} из ${total}…`));
      entries = await db.getAllEntries();
      thumbs.clear();
      // После полной загрузки напоминание не нужно: эти записи уже лежат в файле копии.
      if (!res.noSpace && !getLocal('lastBackup')) setLocal('lastBackup', String(Date.now()));
      if (token !== renderToken) return;
      const lines = [`Готово. Добавлено записей: ${res.added}, обновлено: ${res.updated}, файлов видео и голоса: ${res.videos}.`];
      if (res.same) lines.push(`Уже были на этом устройстве: ${res.same}.`);
      if (res.missingVideos) lines.push(`В копии не хватало файлов: ${res.missingVideos}.`);
      if (res.noSpace) lines.push('Место закончилось, поэтому загружена только часть записей. Освободите место и загрузите эту же копию ещё раз — повторов не будет.');
      if (res.hevc && !canPlayHevc()) lines.push(`В копии есть видео с айфона в формате HEVC. Они сохранены, но это устройство может их не показать. ${HEVC_HINT}`);
      say(lines.join(' '));
    } catch (err) {
      try { entries = await db.getAllEntries(); } catch { /* останется прежний список */ }
      if (token === renderToken) say(err instanceof BackupError ? err.message : 'Не получилось загрузить копию. Уже имеющиеся записи не тронуты.');
    } finally {
      working = false;
    }
  }

  importInput.addEventListener('change', () => { const f = importInput.files[0]; importInput.value = ''; loadBackup(f); });

  const trashCount = entries.filter((e) => e.deletedAt).length;

  screen({
    title: 'Настройки',
    back: '#/',
    body: [
      h('section', { class: 'panel' },
        h('h2', null, 'Тема'),
        h('div', { class: 'row' }, themeBtn('dark', 'Тёмная'), themeBtn('light', 'Светлая'))),
      h('section', { class: 'panel' },
        h('h2', null, 'Резервная копия'),
        h('p', null, 'Один файл со всеми записями, видео и голосом. Это единственная защита, если телефон потеряется или сломается.'),
        lastLine,
        h('div', { class: 'row' },
          btn('Сделать копию', makeBackup),
          btn('Загрузить из копии', () => importInput.click()),
          importInput),
        backupStatus,
        backupResult),
      h('section', { class: 'panel' },
        h('h2', null, 'Место'),
        h('p', null, 'Записи хранятся только на этом устройстве, внутри приложения.'),
        space,
        guard),
      h('section', { class: 'panel' },
        h('h2', null, 'Удалённые записи'),
        h('p', null, trashCount ? `Сейчас там: ${plural(trashCount, 'запись', 'записи', 'записей')}. Хранятся ${TRASH_DAYS} дней.` : 'Сейчас там пусто.'),
        trashCount ? h('div', { class: 'row' }, btn('Открыть удалённые', () => go('#/trash'))) : null),
    ],
  });
}

// ---------- Удалённые записи ----------

function renderTrash() {
  const list = entries.filter((e) => e.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);

  async function restore(e) {
    const back = { ...e, updatedAt: Date.now() };
    delete back.deletedAt;
    try {
      await db.putEntry(back);
      cache(back);
      notice = { text: 'Запись возвращена в ленту.' };
    } catch {
      notice = { text: 'Не получилось вернуть запись.' };
    }
    render();
  }

  async function erase(e) {
    const ok = await confirmDialog('Удалить навсегда?', 'Запись, её видео и голос нельзя будет вернуть.', 'Удалить навсегда');
    if (!ok) return;
    try {
      await db.deleteEntry(e.id, e.videos.map((v) => v.id));
      entries = entries.filter((x) => x.id !== e.id);
      notice = { text: 'Запись удалена навсегда.' };
    } catch {
      notice = { text: 'Не получилось удалить запись.' };
    }
    render();
  }

  screen({
    title: 'Удалённые записи',
    back: '#/settings',
    body: list.length
      ? list.map((e) => card(e, {
        fullDate: true,
        extra: h('div', { class: 'row' }, btn('Вернуть', () => restore(e)), btn('Удалить навсегда', () => erase(e), 'btn-danger')),
      }))
      : [h('p', { class: 'muted' }, 'Здесь пусто.')],
  });
}

// ---------- Запуск ----------

// Уборка при запуске: старые удалённые записи и файлы, на которые ничто не ссылается.
async function tidy() {
  const old = entries.filter((e) => e.deletedAt && Date.now() - e.deletedAt > TRASH_DAYS * DAY);
  for (const e of old) {
    await db.deleteEntry(e.id, e.videos.map((v) => v.id));
    entries = entries.filter((x) => x.id !== e.id);
  }

  // Сначала список файлов, потом ссылки на них: файл, добавленный позже, под уборку не попадёт.
  const all = await db.getAllVideoKeys();
  const used = new Set();
  for (const e of entries) for (const v of e.videos) used.add(v.id);
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('draft:')) continue;
    const d = JSON.parse(localStorage.getItem(key)); // если черновик не читается, уборку не делаем
    for (const v of d.videos || []) used.add(v.id);
  }
  await db.deleteVideos(all.filter((id) => !used.has(id)));
}

async function start() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  try {
    entries = await db.getAllEntries();
  } catch {
    app.replaceChildren(h('main', null,
      h('h1', null, 'Дневник'),
      h('p', { class: 'warn' }, 'Не получилось открыть хранилище на этом устройстве. Так бывает в режиме «Частный доступ» (инкогнито). Откройте приложение в обычном окне.')));
    return;
  }
  if (!history.state) history.replaceState({ d: 0 }, '', location.hash || '#/');
  render();

  tidy().catch(() => { /* уборка необязательна, повторится при следующем запуске */ });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) {
    // Если пришла новая версия приложения, спокойно предлагаем перезапуск. Сами ничего не перезагружаем.
    const hadWorker = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadWorker || document.querySelector('.update')) return;
      document.body.prepend(h('p', { class: 'notice update', role: 'status' },
        'Приложение обновилось. ', btn('Перезапустить', () => location.reload())));
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

start();
