// Страница панели. Имена файлов и любые чужие строки попадают в DOM только через textContent.
import { canPush, client, DEV_TAGS, loadDevlog, loadState, mediaExt, modKey, nextVersion, publishDevlog, publishSafe } from './core.js?v=4';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const say = (text, cls = 'm') => {
  $('#status').className = `${cls} grow`;
  $('#status').textContent = text;
};
const mb = (n) => `${(n / 1048576).toFixed(1)} МБ`;
const KEY = 'shizostan-panel-token';
const stored = () => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};

let token = stored();
let gh = client(token);
let state; // что лежит в репозитории
let live = null; // версия, которую сейчас отдаёт сайт игрокам
const adds = new Map(); // имя -> File, добавятся при публикации
const removes = new Set(); // 'mods/x.jar', удалятся при публикации
let waitFor = null;
const media = []; // { file, url } — картинки и видео нового поста «Разработки»
let posts = []; // опубликованные посты

$('#mk').href = 'https://github.com/settings/tokens/new?scopes=public_repo&description=SHIZOSTAN%20panel';

async function checkLive() {
  live = await fetch(`../pack.json?t=${Date.now()}`).then((r) => r.json()).then((j) => j.version, () => null);
  $('#live').textContent = live ?? 'нет связи';
  if (!state) return;
  const same = live && live === state.pack.version;
  $('#sync').textContent = !live ? 'Не удалось узнать версию на сайте.' : same ? 'Игроки получают последнюю собранную версию.' : 'Сайт ещё обновляется: GitHub публикует новую версию 1–6 минут.';
  $('#sync').className = same ? 'okc' : 'warnc';
  if (waitFor && live === waitFor) {
    say(`Версия ${waitFor} уже у игроков.`, 'okc');
    waitFor = null;
  }
}

async function load() {
  state = await loadState(gh);
  $('#cur').textContent = state.pack.version ?? '—';
  $('#ver').value = nextVersion(state.pack.version);
  draw();
  await checkLive();
}

function draw() {
  const q = $('#find').value.toLowerCase();
  const mods = state.files.filter((f) => f.path.startsWith('mods/')).map((f) => ({ name: f.path.slice(5), size: f.size, status: f.status, path: f.path }));
  const rows = [...[...adds.values()].map((f) => ({ name: f.name, size: f.size, status: 'add' })), ...mods.filter((m) => !adds.has(m.name))];
  const alive = rows.filter((r) => !removes.has(r.path));
  const count = {};
  for (const r of alive) count[modKey(r.name)] = (count[modKey(r.name)] ?? 0) + 1;
  $('#count').textContent = alive.length;

  const list = $('#list');
  list.replaceChildren();
  const LABEL = { add: 'добавится', new: 'не в списке', changed: 'заменён' };
  for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    if (q && !r.name.toLowerCase().includes(q)) continue;
    const off = removes.has(r.path);
    const li = el('li', off ? 'off' : '');
    li.append(el('span', 'n', r.name));
    if (off) li.append(el('span', 'tag gone', 'удалится'));
    else if (count[modKey(r.name)] > 1) li.append(el('span', 'tag dupe', 'две версии?'));
    if (!off && LABEL[r.status]) li.append(el('span', `tag ${r.status}`, LABEL[r.status]));
    li.append(el('span', 'm', mb(r.size)));
    const btn = el('button', off ? 'x' : 'x del', off ? 'Вернуть' : r.status === 'add' ? 'Убрать' : 'Удалить');
    btn.setAttribute('aria-label', `${btn.textContent} ${r.name}`);
    btn.onclick = () => {
      if (r.status === 'add') adds.delete(r.name);
      else if (off) removes.delete(r.path);
      else removes.add(r.path);
      draw();
    };
    li.append(btn);
    list.append(li);
  }

  const parts = [];
  if (adds.size) parts.push(`добавится: ${adds.size}`);
  if (removes.size) parts.push(`удалится: ${removes.size}`);
  const outside = mods.filter((m) => m.status !== 'same').length + state.missing.length;
  if (outside) parts.push(`загружено мимо панели: ${outside}`);
  const dupes = Object.keys(count).filter((k) => count[k] > 1);
  $('#changes').textContent =
    (parts.length ? `В этом обновлении — ${parts.join(', ')}.` : 'Изменений пока нет.') +
    (dupes.length ? ` Похоже на две версии одного мода: ${dupes.join(', ')} — оставь одну, иначе игра может не запуститься.` : '');
  $('#changes').className = dupes.length ? 'warnc' : 'm';
}

function add(files) {
  for (const f of files) {
    if (!/\.jar$/i.test(f.name)) say(`${f.name}: нужен файл .jar`, 'badc');
    else {
      adds.set(f.name, f);
      removes.delete(`mods/${f.name}`);
      say(`${f.name} добавится при публикации.`, 'okc');
    }
  }
  draw();
}

async function signIn(value) {
  gh = client(value);
  if (!(await canPush(gh))) throw new Error('У этого ключа нет права изменять репозиторий — прими приглашение и создай ключ по ссылке выше');
  token = value;
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // приватное окно: ключ проживёт до закрытия вкладки
  }
}

function showAuth() {
  $('#login').hidden = !!token;
  $('#logout').hidden = !token;
  $('#pub').disabled = !token;
  $('#dpub').disabled = !token;
  drawPosts();
  if (!token) say('Чтобы публиковать, войди ключом GitHub (блок наверху).');
}

$('#enter').onclick = async () => {
  const value = $('#token').value.trim();
  if (!value) return;
  $('#enter').disabled = true;
  try {
    await signIn(value);
    $('#token').value = '';
    say('Вход выполнен.', 'okc');
  } catch (e) {
    gh = client(token);
    say(e.message, 'badc');
  }
  $('#enter').disabled = false;
  showAuth();
};
$('#logout').onclick = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // нечего удалять
  }
  token = '';
  gh = client('');
  showAuth();
};

const drop = $('#drop');
drop.onclick = () => $('#pick').click();
drop.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && $('#pick').click();
$('#pick').onchange = (e) => (add([...e.target.files]), (e.target.value = ''));
for (const ev of ['dragenter', 'dragover']) addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('over')));
for (const ev of ['dragleave', 'drop']) addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove('over')));
addEventListener('drop', (e) => add([...e.dataTransfer.files]));
$('#find').oninput = draw;
addEventListener('beforeunload', (e) => (adds.size || removes.size || media.length) && e.preventDefault()); // не потерять неопубликованное

$('#pub').onclick = async () => {
  const version = $('#ver').value.trim();
  const log = [];
  const step = (text) => {
    log.push(`▸ ${text}`);
    $('#out').hidden = false;
    $('#out').textContent = log.join('\n');
  };
  $('#pub').disabled = true;
  say('Публикую… не закрывай страницу.');
  try {
    const files = await Promise.all([...adds.values()].map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
    state = await loadState(gh); // свежее состояние прямо перед публикацией: страница могла быть открыта давно
    const done = await publishSafe(gh, state, { version, changelog: $('#notes').value, news: $('#news').value, adds: files, removes: [...removes], onStep: step });
    step('Готово');
    adds.clear();
    removes.clear();
    $('#notes').value = '';
    $('#news').value = '';
    waitFor = done.pack.version;
    say(`Отправлено. Жду, пока GitHub опубликует версию ${waitFor} (1–6 минут)…`, 'warnc');
    await load();
  } catch (e) {
    step(`✖ ${e.message}`);
    say('Не получилось — подробности ниже.', 'badc');
  }
  $('#pub').disabled = !token;
};

// ---------- посты для вкладки «Разработка» ----------
const dsay = (text, cls = 'm') => {
  $('#dstatus').className = `${cls} grow`;
  $('#dstatus').textContent = text;
};

function drawMedia() {
  const list = $('#dmedia');
  list.replaceChildren();
  media.forEach((m, n) => {
    const li = el('li');
    li.title = `${m.file.name} · ${mb(m.file.size)}`;
    const preview = m.file.type.startsWith('video/') ? Object.assign(el('video'), { muted: true, loop: true, autoplay: true }) : el('img');
    preview.src = m.url;
    const x = el('button', 'x del', '✕');
    x.setAttribute('aria-label', `Убрать ${m.file.name}`);
    x.onclick = () => (URL.revokeObjectURL(m.url), media.splice(n, 1), drawMedia());
    li.append(preview, x);
    list.append(li);
  });
}

function addMedia(files) {
  for (const f of files) {
    if (!mediaExt(f.name)) dsay(`${f.name}: подходят PNG, JPG, GIF, WebP, MP4 и WebM`, 'badc');
    else if (media.length >= 10) dsay('Не больше 10 файлов в одном посте', 'badc');
    else media.push({ file: f, url: URL.createObjectURL(f) });
  }
  drawMedia();
}

function drawPosts() {
  const list = $('#dposts');
  list.replaceChildren();
  if (!posts.length) list.append(el('li', 'm', 'Постов пока нет.'));
  for (const p of posts) {
    const li = el('li');
    li.append(el('span', `tag ${p.tag}`, DEV_TAGS[p.tag] ?? p.tag), el('span', 'n', p.title), el('span', 'm', new Date(p.date).toLocaleDateString('ru')));
    if (token) {
      const del = el('button', 'x del', 'Удалить');
      del.setAttribute('aria-label', `Удалить пост ${p.title}`);
      del.onclick = async () => {
        if (!confirm(`Удалить пост «${p.title}» вместе с его картинками?`)) return;
        del.disabled = true;
        try {
          posts = await publishDevlog(gh, { removeId: p.id, onStep: dsay });
          dsay('Пост удалён. Из лаунчера пропадёт через 1–6 минут.', 'okc');
        } catch (e) {
          dsay(e.message, 'badc');
        }
        drawPosts();
      };
      li.append(del);
    }
    list.append(li);
  }
}

const ddrop = $('#ddrop');
ddrop.onclick = () => $('#dpick').click();
ddrop.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && $('#dpick').click();
$('#dpick').onchange = (e) => (addMedia([...e.target.files]), (e.target.value = ''));
// Свой обработчик и stopPropagation: иначе общий «перетащи .jar» на странице примет картинку за мод
ddrop.addEventListener('dragover', (e) => (e.preventDefault(), e.stopPropagation(), ddrop.classList.add('over')));
ddrop.addEventListener('dragleave', () => ddrop.classList.remove('over'));
ddrop.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  ddrop.classList.remove('over');
  drop.classList.remove('over');
  addMedia([...e.dataTransfer.files]);
});

$('#dpub').onclick = async () => {
  $('#dpub').disabled = true;
  dsay('Публикую… не закрывай страницу.');
  try {
    const files = await Promise.all(media.map(async (m) => ({ name: m.file.name, data: await m.file.arrayBuffer() })));
    posts = await publishDevlog(gh, { post: { title: $('#dtitle').value, tag: $('#dtag').value, text: $('#dtext').value }, media: files, onStep: dsay });
    for (const m of media) URL.revokeObjectURL(m.url);
    media.length = 0;
    $('#dtitle').value = '';
    $('#dtext').value = '';
    drawMedia();
    drawPosts();
    dsay('Пост опубликован. В лаунчере появится через 1–6 минут, пока GitHub обновляет сайт.', 'okc');
  } catch (e) {
    dsay(e.message, 'badc');
  }
  $('#dpub').disabled = !token;
};

showAuth();
load().catch((e) => say(e.message, 'badc'));
loadDevlog(gh).then((d) => ((posts = d.posts), drawPosts()), () => {});
setInterval(() => checkLive().catch(() => {}), 20000);
