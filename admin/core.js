// Ядро веб-панели: чтение и публикация сборки через API GitHub. Без DOM — проверяется тестом в Node.
export const REPO = 'Maretstem/shizo-mods';
const MAX_FILE = 95 * 1024 * 1024; // GitHub не принимает файлы около 100 МБ и больше

const ERRORS = {
  401: 'Ключ не подходит или истёк — создай новый и вставь заново',
  403: 'Нет прав или исчерпан лимит запросов GitHub — проверь, что тебя добавили в репозиторий, или подожди час',
  404: 'Нет доступа к репозиторию — владелец должен добавить тебя в Collaborators, а ты — принять приглашение',
  409: 'Репозиторий изменился, пока ты работал — обнови страницу и повтори',
};

export function client(token, base = 'https://api.github.com') {
  return async (path, { method = 'GET', body, raw } = {}) => {
    const res = await fetch(`${base}/repos/${REPO}${path}`, {
      method,
      cache: 'no-store', // GitHub разрешает браузеру минуту помнить ответ — панель видела бы вчерашний день
      headers: {
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))).message;
      throw Object.assign(new Error(ERRORS[res.status] ?? `GitHub ответил ошибкой ${res.status}${detail ? `: ${detail}` : ''}`), { status: res.status });
    }
    return raw ? res.arrayBuffer() : res.json();
  };
}

export async function sha1Hex(buffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', buffer))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// «binary-barrier-1.4.1.jar» -> «binary-barrier»: два файла с одним ключом — скорее всего две версии одного мода
export const modKey = (name) => name.toLowerCase().replace(/\.jar$/, '').replace(/[-_+ ]?v?\d.*$/, '') || name.toLowerCase();
export const nextVersion = (v) => (/\d/.test(v ?? '') ? v.replace(/(\d+)(?!.*\d)/, (n) => String(Number(n) + 1)) : '1.0.0');

// Настройки игрок меняет под себя — ставятся один раз (то же правило, что в tools/make-pack.mjs лаунчера)
const keepsUserEdits = (p) => p.startsWith('config/') || p === 'options.txt' || p === 'servers.dat';

export async function canPush(gh) {
  return !!(await gh('')).permissions?.push;
}

// Что сейчас лежит в ветке main: файлы сборки и опубликованный pack.json
export async function loadState(gh) {
  const head = (await gh('/git/ref/heads/main')).object.sha;
  const treeSha = (await gh(`/git/commits/${head}`)).tree.sha;
  const tree = await gh(`/git/trees/${treeSha}?recursive=1`);
  if (tree.truncated) throw new Error('В репозитории слишком много файлов для панели');
  const files = tree.tree.filter((e) => e.type === 'blob' && e.path.startsWith('files/')).map((e) => ({ path: e.path.slice(6), git: e.sha, size: e.size }));
  const packBlob = tree.tree.find((e) => e.path === 'pack.json');
  const pack = packBlob ? JSON.parse(new TextDecoder().decode(await gh(`/git/blobs/${packBlob.sha}`, { raw: true }))) : { files: [] };
  const known = new Map(pack.files.map((f) => [f.path, f]));
  for (const f of files) {
    const old = known.get(f.path);
    f.status = !old ? 'new' : old.git === f.git ? 'same' : old.git ? 'changed' : 'same';
  }
  return { head, treeSha, files, pack, missing: pack.files.filter((f) => !files.some((x) => x.path === f.path)).map((f) => f.path) };
}

// adds: [{ name, data: ArrayBuffer }] — новые моды; removes: ['mods/x.jar'] — пути внутри сборки.
// Один коммит: файлы + пересчитанный pack.json, затем обе ветки (main и gh-pages, с которой раздаёт сайт).
export async function publish(gh, state, { version, changelog = '', news = '', adds = [], removes = [], onStep = () => {} }) {
  version = String(version ?? '').trim();
  if (!/^[\w.+-]{1,32}$/.test(version)) throw new Error('Версия: цифры, буквы и точки, например 1.0.6');
  if (version === state.pack.version) throw new Error(`Версия ${version} уже выпущена — поставь новый номер, иначе лаунчеры не заметят обновление`);
  for (const a of adds) {
    if (!/^[^\\/]+\.jar$/i.test(a.name)) throw new Error(`${a.name}: нужен файл .jar`);
    if (a.data.byteLength > MAX_FILE) throw new Error(`${a.name}: больше 95 МБ — GitHub такой не примет`);
  }

  const gone = new Set([...removes, ...adds.map((a) => `mods/${a.name}`)]);
  const known = new Map(state.pack.files.map((f) => [f.path, f]));
  const entries = [];
  for (const f of state.files.filter((x) => !gone.has(x.path))) {
    const old = known.get(f.path);
    let sha1 = old?.git === f.git ? old.sha1 : null;
    if (!sha1) {
      // Файл попал в репозиторий мимо панели (например, через сайт) — хеш надо посчитать по содержимому
      onStep(`Проверяю ${f.path}`);
      sha1 = await sha1Hex(await gh(`/git/blobs/${f.git}`, { raw: true }));
    }
    entries.push({ path: f.path, sha1, size: f.size, git: f.git });
  }
  const tree = [];
  for (const a of adds) {
    onStep(`Загружаю ${a.name}`);
    const git = (await gh('/git/blobs', { method: 'POST', body: { content: base64(a.data), encoding: 'base64' } })).sha;
    entries.push({ path: `mods/${a.name}`, sha1: await sha1Hex(a.data), size: a.data.byteLength, git });
    tree.push({ path: `files/mods/${a.name}`, mode: '100644', type: 'blob', sha: git });
  }
  for (const p of removes) if (state.files.some((f) => f.path === p)) tree.push({ path: `files/${p}`, mode: '100644', type: 'blob', sha: null });

  const pack = {
    ...state.pack,
    version,
    changelog: String(changelog).trim(),
    // История для блока «Что нового» в лаунчере (то же правило, что в tools/make-pack.mjs)
    // Новость на главной лаунчера: необязательна, хранятся последние 10
    news: news.trim() ? [{ date: new Date().toISOString().slice(0, 10), text: news.trim() }, ...(state.pack.news ?? [])].slice(0, 10) : state.pack.news ?? [],
    history: [{ version, date: new Date().toISOString().slice(0, 10), changelog: String(changelog).trim() }, ...(state.pack.history ?? []).filter((h) => h.version !== version)].slice(0, 30),
    files: entries.sort((a, b) => a.path.localeCompare(b.path)).map((f) => (keepsUserEdits(f.path) ? { ...f, overwrite: false } : f)),
  };
  tree.push({ path: 'pack.json', mode: '100644', type: 'blob', content: JSON.stringify(pack, null, 2) + '\n' });

  onStep('Сохраняю версию');
  const newTree = (await gh('/git/trees', { method: 'POST', body: { base_tree: state.treeSha, tree } })).sha;
  const commit = (await gh('/git/commits', { method: 'POST', body: { message: `Сборка ${version}`, tree: newTree, parents: [state.head] } })).sha;
  onStep('Публикую');
  await pushBranches(gh, commit);
  return pack;
}

// main без force: если другой админ успел раньше, GitHub откажет — вызывающий пересоберёт поверх его версии.
// gh-pages (с неё раздаёт сайт) просто ставится на тот же коммит.
async function pushBranches(gh, commit) {
  await gh('/git/refs/heads/main', { method: 'PATCH', body: { sha: commit } }).catch((e) => {
    throw e.status === 422 ? Object.assign(new Error('Кто-то опубликовал изменения раньше тебя'), { conflict: true }) : e;
  });
  await gh('/git/refs/heads/gh-pages', { method: 'PATCH', body: { sha: commit, force: true } }).catch((e) => {
    if (e.status !== 404 && e.status !== 422) throw e;
    return gh('/git/refs', { method: 'POST', body: { ref: 'refs/heads/gh-pages', sha: commit } });
  });
}

// ---------- вкладка «Разработка» в лаунчере: devlog.json + картинки, GIF и видео в папке devlog/ ----------
export const DEV_TAGS = { dev: 'Разработка', event: 'Ивент', update: 'Обновление' };
const MEDIA = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', mp4: 'video', webm: 'video' };
const MAX_MEDIA = 25 * 1024 * 1024; // большие GIF и видео игроки будут грузить долго
export const mediaExt = (name) => {
  const ext = name.toLowerCase().split('.').pop();
  return MEDIA[ext] ? ext : null;
};

export async function loadDevlog(gh) {
  const head = (await gh('/git/ref/heads/main')).object.sha;
  const treeSha = (await gh(`/git/commits/${head}`)).tree.sha;
  const tree = await gh(`/git/trees/${treeSha}?recursive=1`);
  const blob = tree.tree.find((e) => e.path === 'devlog.json');
  const devlog = blob ? JSON.parse(new TextDecoder().decode(await gh(`/git/blobs/${blob.sha}`, { raw: true }))) : { posts: [] };
  return { head, treeSha, paths: new Set(tree.tree.map((e) => e.path)), posts: Array.isArray(devlog.posts) ? devlog.posts : [] };
}

// post: { title, tag, text } + media: [{ name, data: ArrayBuffer }] — новый пост; removeId — удалить пост вместе с его файлами.
// Версию сборки не трогает. Если другой админ публиковал одновременно — берёт свежее состояние и повторяет.
export async function publishDevlog(gh, { post, media = [], removeId, onStep = () => {}, now = new Date() }) {
  let fresh;
  if (post) {
    const title = String(post.title ?? '').trim();
    if (!title) throw new Error('Напиши заголовок поста');
    if (title.length > 120) throw new Error('Заголовок длиннее 120 символов');
    if (!DEV_TAGS[post.tag]) throw new Error('Неизвестный тип поста');
    if (media.length > 10) throw new Error('Не больше 10 картинок и видео в одном посте');
    for (const m of media) {
      if (!mediaExt(m.name)) throw new Error(`${m.name}: подходят PNG, JPG, GIF, WebP, MP4 и WebM`);
      if (m.data.byteLength > MAX_MEDIA) throw new Error(`${m.name}: больше 25 МБ — сожми или обрежь`);
    }
    const id = now.getTime().toString(36);
    // Файлы загружаются один раз, даже если публикацию придётся повторить
    const files = [];
    for (const [n, m] of media.entries()) {
      onStep(`Загружаю ${m.name}`);
      const ext = mediaExt(m.name);
      files.push({ path: `devlog/${id}-${n}.${ext}`, type: MEDIA[ext], sha: (await gh('/git/blobs', { method: 'POST', body: { content: base64(m.data), encoding: 'base64' } })).sha });
    }
    fresh = { id, date: now.toISOString(), title, tag: post.tag, text: String(post.text ?? '').trim().slice(0, 5000), media: files.map((f) => ({ src: f.path, type: f.type })), files };
  }
  for (let attempt = 1; ; attempt++) {
    const s = await loadDevlog(gh);
    const tree = [];
    let posts = s.posts.filter((p) => p.id !== removeId);
    if (fresh) {
      const { files, ...p } = fresh;
      posts = [p, ...posts];
      for (const f of files) tree.push({ path: f.path, mode: '100644', type: 'blob', sha: f.sha });
    }
    const kept = posts.slice(0, 50); // старые посты уходят вместе с файлами
    const keptIds = new Set(kept.map((p) => p.id));
    for (const p of s.posts.filter((x) => !keptIds.has(x.id))) {
      for (const m of p.media ?? []) if (s.paths.has(m.src)) tree.push({ path: m.src, mode: '100644', type: 'blob', sha: null });
    }
    tree.push({ path: 'devlog.json', mode: '100644', type: 'blob', content: JSON.stringify({ posts: kept }, null, 2) + '\n' });
    onStep('Сохраняю');
    const newTree = (await gh('/git/trees', { method: 'POST', body: { base_tree: s.treeSha, tree } })).sha;
    const message = fresh ? `Разработка: ${fresh.title}` : `Разработка: удалён пост ${removeId}`;
    const commit = (await gh('/git/commits', { method: 'POST', body: { message, tree: newTree, parents: [s.head] } })).sha;
    onStep('Публикую');
    try {
      await pushBranches(gh, commit);
      return kept;
    } catch (e) {
      if (!e.conflict || attempt >= 3) throw e;
      onStep('Кто-то публиковал одновременно — повторяю поверх свежей версии');
    }
  }
}

// Публикация, которая переживает одновременную работу двух админов: если ветка успела уйти вперёд,
// берём свежее состояние и накладываем те же добавления и удаления поверх чужой версии.
// Занятый номер версии заменяется следующим свободным. Возвращает { pack, state } — что в итоге опубликовано.
export async function publishSafe(gh, state, opts) {
  const onStep = opts.onStep ?? (() => {});
  for (let attempt = 1; ; attempt++) {
    const taken = state.pack.version;
    if (taken === opts.version || (state.pack.history ?? []).some((h) => h.version === opts.version)) {
      opts = { ...opts, version: nextVersion(taken) };
      onStep(`Номер уже занят другим админом, выпускаю как ${opts.version}`);
    }
    try {
      return { pack: await publish(gh, state, opts), state };
    } catch (e) {
      if (!e.conflict || attempt >= 3) throw e;
      onStep('Другой админ опубликовал сборку секунду назад — собираю поверх его версии');
      state = await loadState(gh);
    }
  }
}
