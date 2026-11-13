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
export async function publish(gh, state, { version, changelog = '', adds = [], removes = [], onStep = () => {} }) {
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
    history: [{ version, date: new Date().toISOString().slice(0, 10), changelog: String(changelog).trim() }, ...(state.pack.history ?? []).filter((h) => h.version !== version)].slice(0, 30),
    files: entries.sort((a, b) => a.path.localeCompare(b.path)).map((f) => (keepsUserEdits(f.path) ? { ...f, overwrite: false } : f)),
  };
  tree.push({ path: 'pack.json', mode: '100644', type: 'blob', content: JSON.stringify(pack, null, 2) + '\n' });

  onStep('Сохраняю версию');
  const newTree = (await gh('/git/trees', { method: 'POST', body: { base_tree: state.treeSha, tree } })).sha;
  const commit = (await gh('/git/commits', { method: 'POST', body: { message: `Сборка ${version}`, tree: newTree, parents: [state.head] } })).sha;
  onStep('Публикую');
  // Без force: если другой админ успел раньше, GitHub откажет — publishSafe пересоберёт поверх его версии
  await gh('/git/refs/heads/main', { method: 'PATCH', body: { sha: commit } }).catch((e) => {
    throw e.status === 422 ? Object.assign(new Error('Кто-то опубликовал сборку раньше тебя'), { conflict: true }) : e;
  });
  await gh('/git/refs/heads/gh-pages', { method: 'PATCH', body: { sha: commit, force: true } }).catch((e) => {
    if (e.status !== 404 && e.status !== 422) throw e;
    return gh('/git/refs', { method: 'POST', body: { ref: 'refs/heads/gh-pages', sha: commit } });
  });
  return pack;
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
