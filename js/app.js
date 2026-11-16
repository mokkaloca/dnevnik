// Экраны приложения и переходы между ними.

import * as db from './db.js';
import { exportBackup, importBackup, BackupError } from './backup.js';
import {
  uid, nowLocal, DATE_RE, fmtDay, fmtDate, fmtTime, fmtSize, plural,
  isVideoFile, canPlayHevc, playableType, sniffHevc, freeSpace,
} from './util.js';

const DAY = 24 * 60 * 60 * 1000;
const TRASH_DAYS = 30;
const BACKUP_DAYS = 30;
const PAGE = 60;

const app = document.getElementById('app');
let entries = []; // все записи, включая удалённые (без видеофайлов)
let notice = null; // строка вверху экрана после действия, например «Запись удалена. Отменить»
let urls = []; // временные ссылки на видео, которые надо освободить при уходе с экрана
let searchQuery = '';
let feedLimit = PAGE;
let renderToken = 0;
const scrollPos = {};

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

function btn(label, onclick, cls = '') {
  return h('button', { type: 'button', class: `btn ${cls}`.trim(), onclick }, label);
}

function link(label, hash) {
  return h('a', { href: hash, onclick: (ev) => { ev.preventDefault(); go(hash); } }, label);
}

function playIcon() {
  const s = h('span', { class: 'play', 'aria-hidden': 'true' });
  s.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
  return s;
}

function confirmDialog(title, text, okLabel, okClass = 'btn-danger-solid') {
  return new Promise((resolve) => {
    const d = h('dialog', { class: 'dlg' });
    const close = (value) => { d.close(); d.remove(); resolve(value); };
    add(d, [
      h('h2', null, title),
      text ? h('p', null, text) : null,
      h('div', { class: 'row' },
        btn('Отмена', () => close(false)),
        okLabel ? btn(okLabel, () => close(true), okClass) : null),
    ]);
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); close(false); });
    document.body.append(d);
    d.showModal();
  });
}

// ---------- Переходы ----------
// Путь всегда один: лента → запись → изменение. «Назад» возвращает на шаг выше.

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return { name: parts[0] || 'feed', id: parts[1] ? decodeURIComponent(parts[1]) : null };
}

function go(hash) {
  scrollPos[location.hash || '#/'] = window.scrollY;
  history.pushState({ d: ((history.state && history.state.d) || 0) + 1 }, '', hash);
  render();
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
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  if (notice && notice.shown) notice = null;
  const r = route();
  if (r.name === 'new') renderEditor(null);
  else if (r.name === 'edit') renderEditor(r.id);
  else if (r.name === 'entry') renderEntry(r.id);
  else if (r.name === 'search') renderSearch();
  else if (r.name === 'settings') renderSettings();
  else if (r.name === 'trash') renderTrash();
  else renderFeed();
  window.scrollTo(0, scrollTo);
}

// Общий каркас экрана: «Назад», заголовок, содержимое, внизу одна главная кнопка.
function screen({ title, back, actions, body, bar }) {
  app.replaceChildren();
  add(app, [
    h('header', { class: back ? 'top' : 'top top-home' },
      back ? btn('← Назад', () => goBack(back), 'btn-quiet back') : null,
      h('h1', null, title),
      actions ? h('div', { class: 'top-actions' }, actions) : null),
  ]);
  if (notice) {
    const n = notice;
    n.shown = true;
    add(app, [h('p', { class: 'notice', role: 'status' }, n.text + ' ', n.label ? btn(n.label, n.action) : null)]);
  }
  add(app, [h('main', null, body)]);
  if (bar) add(app, [h('div', { class: 'bar' }, h('div', { class: 'bar-in' }, bar))]);
  document.body.classList.toggle('has-bar', !!bar);
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

// ---------- Лента ----------

function card(e, label) {
  return h('a', { class: 'card', href: '#/entry/' + e.id, onclick: (ev) => { ev.preventDefault(); go('#/entry/' + e.id); } },
    h('span', { class: 'card-time' }, label),
    e.text ? h('span', { class: 'card-text' }, e.text.slice(0, 400)) : null,
    e.videos.length
      ? h('span', { class: 'card-video' }, playIcon(), e.videos.length === 1 ? 'Видео' : `${e.videos.length} видео`)
      : null);
}

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
      sameDay.map((e) => card(e, `${e.date.slice(0, 4)} год, ${fmtTime(e.date)}`))));
  }

  if (!list.length) body.push(h('p', { class: 'empty' }, 'Записей пока нет.'));

  let day = null;
  for (const e of list.slice(0, feedLimit)) {
    const key = e.date.slice(0, 10);
    if (key !== day) {
      day = key;
      body.push(h('h2', { class: 'day' }, fmtDay(e.date)));
    }
    body.push(card(e, fmtTime(e.date)));
  }
  if (list.length > feedLimit) {
    body.push(btn('Показать ещё', () => { feedLimit += PAGE; render(window.scrollY); }, 'wide'));
  }

  screen({
    title: 'Дневник',
    actions: [btn('Поиск', () => go('#/search')), btn('Настройки', () => go('#/settings'))],
    body,
    bar: [btn('Новая запись', () => go('#/new'), 'btn-primary wide')],
  });
}

// ---------- Просмотр записи ----------

function renderEntry(id) {
  const e = entries.find((x) => x.id === id);
  if (!e || e.deletedAt) { renderMissing(); return; }
  const token = renderToken;
  const videos = e.videos.map((v, i) => {
    const box = h('div', { class: 'video' }, h('p', { class: 'muted' }, 'Открываю видео…'));
    showVideo(v, i, box, token);
    return box;
  });
  screen({
    title: fmtDay(e.date),
    back: '#/',
    body: [
      h('p', { class: 'muted' }, fmtTime(e.date)),
      e.text ? h('div', { class: 'text' }, e.text) : null,
      videos,
      h('div', { class: 'row end' }, btn('Удалить запись', () => removeEntry(e), 'btn-danger')),
    ],
    bar: [btn('Изменить', () => go('#/edit/' + e.id), 'btn-primary wide')],
  });
}

async function showVideo(v, i, box, token) {
  let blob = null;
  try { blob = await db.getVideoBlob(v.id); } catch { /* покажем сообщение ниже */ }
  if (token !== renderToken) return;
  if (!blob) {
    box.replaceChildren(h('p', { class: 'warn' }, 'Файл этого видео не найден на устройстве.'));
    return;
  }
  // Ссылка на файл в хранилище: браузер читает его по частям, а не целиком.
  const url = URL.createObjectURL(blob.slice(0, blob.size, playableType(v)));
  urls.push(url);
  const video = h('video', { controls: true, playsinline: true, preload: 'metadata', src: url + '#t=0.001' });
  const info = h('p', { class: 'muted' }, `Видео ${i + 1} · ${fmtSize(v.size)} · `,
    h('a', { href: url, download: v.name || 'video' }, 'Сохранить файл'));
  // Плеер показывается всегда. Сообщение появляется, только если видео не открылось или может не открыться.
  const hint = v.hevc && !canPlayHevc()
    ? h('p', { class: 'warn' }, `Это видео снято на айфон в формате HEVC. Если оно не показывается или идёт без картинки — файл цел. ${HEVC_HINT}`)
    : null;
  video.addEventListener('error', () => {
    if (hint) hint.remove();
    video.replaceWith(h('p', { class: 'warn' }, v.hevc
      ? `Это видео снято на айфон в формате HEVC, и это устройство его не показывает. Файл цел. ${HEVC_HINT}`
      : 'Это видео не открывается на этом устройстве. Файл цел: его можно сохранить и открыть другой программой.'));
  });
  box.replaceChildren();
  add(box, [video, info, hint]);
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
    ? { date: String(saved.date || ''), text: saved.text, videos: saved.videos }
    : existing
      ? { date: existing.date, text: existing.text, videos: existing.videos.slice() }
      : { date: nowLocal(), text: '', videos: [] };
  let busy = false;

  const status = h('p', { class: 'muted status', role: 'status' }, saved ? 'Черновик восстановлен.' : '');
  const error = h('p', { class: 'warn', role: 'alert', hidden: true });
  const videoList = h('div', { class: 'attached' });
  const discard = btn('Удалить черновик', discardDraft, 'btn-danger');
  const saveBtn = btn('Сохранить', save, 'btn-primary wide');

  const sameVideos = () => existing && d.videos.length === existing.videos.length && d.videos.every((v, i) => v.id === existing.videos[i].id);
  const changed = () => (existing
    ? d.date !== existing.date || d.text !== existing.text || !sameVideos()
    : d.text.trim() !== '' || d.videos.length > 0);

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

  function drawVideos() {
    videoList.replaceChildren();
    d.videos.forEach((v, i) => {
      add(videoList, [h('div', { class: 'attached-row' },
        h('span', null, playIcon(), `Видео ${i + 1} · ${fmtSize(v.size)}`),
        btn('Убрать', () => {
          if (busy) return;
          d.videos.splice(i, 1);
          // Видео из уже сохранённой записи стирается только после «Сохранить».
          if (!existing || !existing.videos.some((x) => x.id === v.id)) db.deleteVideos([v.id]).catch(() => {});
          keep();
          drawVideos();
        }))]);
    });
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
      if (!isVideoFile(file)) { problems.push(`«${file.name}» — это не видео, файл пропущен.`); continue; }
      status.textContent = files.length > 1 ? `Сохраняю видео ${i + 1} из ${files.length}…` : 'Сохраняю видео…';
      const free = await freeSpace();
      if (free !== null && file.size > free) {
        problems.push(`Не хватает места для видео: нужно ${fmtSize(file.size)}, свободно примерно ${fmtSize(free)}. Видео не добавлено. Текст записи цел.`);
        continue;
      }
      const vid = uid();
      try {
        await db.putVideo(vid, file);
      } catch (err) {
        problems.push(db.isQuotaError(err)
          ? `Не хватило места, видео (${fmtSize(file.size)}) не добавлено. Текст записи цел. Освободите место на устройстве и попробуйте снова.`
          : 'Видео не сохранилось. Текст записи цел. Попробуйте добавить видео ещё раз.');
        continue;
      }
      const hevc = await sniffHevc(file);
      if (hevc && !canPlayHevc()) hevcWarn = true;
      d.videos.push({ id: vid, name: file.name || 'video', type: file.type || '', size: file.size, hevc });
      saveDraft(id, d);
      drawVideos();
    }
    setBusy(false, '');
    keep();
    if (hevcWarn) problems.push(`Видео сохранено, но оно в формате HEVC (так снимает айфон), и это устройство может его не показать. ${HEVC_HINT}`);
    say(problems.join(' '));
  }

  async function save() {
    if (busy) return;
    say('');
    if (!DATE_RE.test(d.date)) { say('Укажите дату и время.'); return; }
    if (d.text.trim() === '' && d.videos.length === 0) { say('Запись пустая. Напишите текст или добавьте видео.'); return; }
    const now = Date.now();
    const videos = d.videos.map((v) => ({ id: v.id, name: v.name, type: v.type, size: v.size, hevc: !!v.hevc }));
    const entry = existing
      ? { ...existing, date: d.date, text: d.text, videos, updatedAt: now }
      : { id: uid(), date: d.date, text: d.text, videos, createdAt: now, updatedAt: now };
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
    const ok = await confirmDialog('Удалить черновик?', existing ? 'Запись останется такой, какой была до изменений.' : 'Текст и видео из черновика будут удалены.', 'Удалить черновик');
    if (!ok) return;
    const keepIds = new Set(existing ? existing.videos.map((v) => v.id) : []);
    const extra = d.videos.filter((v) => !keepIds.has(v.id)).map((v) => v.id);
    clearDraft(id);
    try { await db.deleteVideos(extra); } catch { /* уберётся при следующем запуске */ }
    goBack(existing ? '#/entry/' + existing.id : '#/');
  }

  const dateInput = h('input', { type: 'datetime-local', id: 'f-date', value: d.date });
  dateInput.addEventListener('input', () => { d.date = dateInput.value.slice(0, 16); keep(); });

  const textInput = h('textarea', { id: 'f-text', rows: '8', value: d.text });
  const grow = () => { textInput.style.height = 'auto'; textInput.style.height = textInput.scrollHeight + 2 + 'px'; };
  textInput.addEventListener('input', () => { d.text = textInput.value; keep(); grow(); });

  const cameraInput = h('input', { type: 'file', accept: 'video/*', capture: 'environment', hidden: true });
  const fileInput = h('input', { type: 'file', accept: 'video/*,.mov,.mp4,.m4v,.webm', multiple: true, hidden: true });
  for (const input of [cameraInput, fileInput]) {
    input.addEventListener('change', () => { const files = Array.from(input.files); input.value = ''; addFiles(files); });
  }
  // «Снять» открывает камеру только на телефоне, поэтому на компьютере этой кнопки нет.
  const isPhone = window.matchMedia('(pointer: coarse)').matches;
  const pickers = [
    isPhone ? btn('Снять видео', () => cameraInput.click()) : null,
    btn(isPhone ? 'Выбрать из галереи' : 'Выбрать файл', () => fileInput.click()),
  ].filter(Boolean);

  screen({
    title: existing ? 'Изменение записи' : 'Новая запись',
    back: existing ? '#/entry/' + existing.id : '#/',
    body: [
      h('label', { for: 'f-date' }, 'Дата и время'),
      dateInput,
      h('label', { for: 'f-text' }, 'Текст'),
      textInput,
      h('p', { class: 'label' }, 'Видео'),
      videoList,
      h('div', { class: 'row' }, pickers, cameraInput, fileInput),
      error,
      status,
      h('div', { class: 'row end' }, discard),
    ],
    bar: [saveBtn],
  });
  drawVideos();
  discard.hidden = !changed();
  grow();
}

// ---------- Поиск ----------

function renderSearch() {
  const results = h('div');
  const input = h('input', { type: 'search', id: 'f-search', value: searchQuery, autocomplete: 'off', enterkeyhint: 'search' });

  function draw() {
    const q = searchQuery.trim().toLowerCase();
    results.replaceChildren();
    if (!q) return;
    const found = live().filter((e) => e.text.toLowerCase().includes(q));
    if (!found.length) {
      add(results, [h('p', { class: 'empty' }, 'Ничего не найдено.')]);
      return;
    }
    add(results, [
      h('p', { class: 'muted' }, 'Найдено: ' + plural(found.length, 'запись', 'записи', 'записей')),
      found.slice(0, 200).map((e) => card(e, `${fmtDate(e.date)}, ${fmtTime(e.date)}`)),
    ]);
  }

  input.addEventListener('input', () => { searchQuery = input.value; draw(); });
  screen({
    title: 'Поиск',
    back: '#/',
    body: [h('label', { for: 'f-search' }, 'Слово или фраза из записи'), input, results],
  });
  draw();
  if (!searchQuery) input.focus();
}

// ---------- Настройки ----------

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  setLocal('theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f4f2ee' : '#1c2126';
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
      text = `Занято ${fmtSize(usage)} из примерно ${fmtSize(quota)}, которые браузер даёт приложению.`;
    } catch { /* оставим текст по умолчанию */ }
    let kept = false;
    try { kept = await navigator.storage.persisted(); } catch { /* не поддерживается */ }
    if (token !== renderToken) return;
    space.textContent = text;
    guard.textContent = kept
      ? 'Защита от автоочистки включена: браузер не удалит записи сам.'
      : 'Защита от автоочистки не включена. Обычно браузер включает её после установки приложения. Резервная копия защищает в любом случае.';
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
      const res = await exportBackup(entries, (n, total) => say(`Готовлю копию: видео ${n} из ${total}…`));
      if (token !== renderToken) return;
      say(`Копия готова: ${plural(res.entries, 'запись', 'записи', 'записей')}, видео: ${res.videos}, размер ${fmtSize(res.file.size)}.`
        + (res.missing ? ` Не найдено файлов видео: ${res.missing}.` : ''));
      add(backupResult, [
        btn('Сохранить файл копии', () => saveFile(res.file), 'btn-primary'),
        h('p', { class: 'muted' }, 'Положите файл туда, где он не потеряется: в «Файлы», в облако или на компьютер.'),
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
      // После полной загрузки напоминание не нужно: эти записи уже лежат в файле копии.
      if (!res.noSpace && !getLocal('lastBackup')) setLocal('lastBackup', String(Date.now()));
      if (token !== renderToken) return;
      const lines = [`Готово. Добавлено записей: ${res.added}, обновлено: ${res.updated}, видео: ${res.videos}.`];
      if (res.same) lines.push(`Уже были на этом устройстве: ${res.same}.`);
      if (res.missingVideos) lines.push(`В копии не хватало файлов видео: ${res.missingVideos}.`);
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
      h('section', null,
        h('h2', null, 'Тема'),
        h('div', { class: 'row' }, themeBtn('dark', 'Тёмная'), themeBtn('light', 'Светлая'))),
      h('section', null,
        h('h2', null, 'Резервная копия'),
        h('p', null, 'Один файл со всеми записями и видео. Им же переносят записи на другое устройство.'),
        lastLine,
        h('div', { class: 'row' },
          btn('Сделать копию', makeBackup),
          btn('Загрузить из копии', () => importInput.click()),
          importInput),
        backupStatus,
        backupResult),
      h('section', null,
        h('h2', null, 'Место'),
        h('p', null, 'Записи и видео хранятся только на этом устройстве.'),
        space,
        guard),
      h('section', null,
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
    const ok = await confirmDialog('Удалить навсегда?', 'Запись и её видео нельзя будет вернуть.', 'Удалить навсегда');
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
      ? list.map((e) => h('div', { class: 'card static' },
        h('span', { class: 'card-time' }, `${fmtDate(e.date)}, ${fmtTime(e.date)}`),
        e.text ? h('span', { class: 'card-text' }, e.text.slice(0, 400)) : null,
        e.videos.length ? h('span', { class: 'card-video' }, playIcon(), e.videos.length === 1 ? 'Видео' : `${e.videos.length} видео`) : null,
        h('div', { class: 'row' }, btn('Вернуть', () => restore(e)), btn('Удалить навсегда', () => erase(e), 'btn-danger'))))
      : [h('p', { class: 'empty' }, 'Здесь пусто.')],
  });
}

// ---------- Запуск ----------

// Уборка при запуске: старые удалённые записи и видео, на которые ничто не ссылается.
async function tidy() {
  const old = entries.filter((e) => e.deletedAt && Date.now() - e.deletedAt > TRASH_DAYS * DAY);
  for (const e of old) {
    await db.deleteEntry(e.id, e.videos.map((v) => v.id));
    entries = entries.filter((x) => x.id !== e.id);
  }

  // Сначала список файлов, потом ссылки на них: видео, добавленное позже, под уборку не попадёт.
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

start();
