#!/usr/bin/env node
// Сборка графа дебюта из tools/lines/<id>.lines.json:
//  1) проигрывает все варианты через chess.js (нелегальный ход = ошибка сборки);
//  2) обогащает ходы статистикой Lichess Masters DB (нужен LICHESS_TOKEN; ответы кэшируются в tools/cache);
//  3) пишет data/openings/<id>.json и отчёт tools/report/<id>.md.
// Запуск: node tools/build-opening.mjs [id ...]   (без аргументов — все файлы в tools/lines)
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from '../vendor/chess.js';
import { fenKey, sideToMove } from '../js/fen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINES_DIR = path.join(ROOT, 'tools/lines');
const CACHE_DIR = path.join(ROOT, 'tools/cache');
const REPORT_DIR = path.join(ROOT, 'tools/report');
const OUT_DIR = path.join(ROOT, 'data/openings');
// .env (в .gitignore): LICHESS_TOKEN=...
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const TOKEN = process.env.LICHESS_TOKEN;
const EXPLORER = 'https://explorer.lichess.org/masters';
const MIN_SHARE = 0.02; // ход считается «подтверждённым», если его доля ≥ 2 %
const UNCOVERED_SHARE = 0.1; // предупреждать о непокрытом ответе с долей ≥ 10 %
const MAX_REPORT_PLY = 20;

for (const d of [CACHE_DIR, REPORT_DIR, OUT_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

// ---------- мини-PGN: ходы + {комментарии}, без вложенных вариантов ----------
export function parsePgn(text) {
  const out = [];
  const re = /\{([^}]*)\}|(\d+)\.(\.\.)?|(\$\d+)|([^\s{}]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) {
      if (!out.length) throw new Error(`Комментарий до первого хода: ${text.slice(0, 40)}`);
      out[out.length - 1].comment = m[1].trim().replace(/\s+/g, ' ');
    } else if (m[2] !== undefined || m[4] !== undefined) {
      // номер хода или NAG — пропускаем
    } else if (m[5] !== undefined) {
      out.push({ san: m[5], comment: '' });
    }
  }
  return out;
}

// ---------- Lichess explorer ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function explorer(fen) {
  const file = path.join(CACHE_DIR, createHash('sha1').update(fen).digest('hex').slice(0, 16) + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (!TOKEN) return null;
  const url = `${EXPLORER}?fen=${encodeURIComponent(fen)}&moves=20&topGames=0`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'open_game build script' } });
    if (res.status === 429) {
      console.warn('429 от explorer, пауза 60 с');
      await sleep(60_000);
      continue;
    }
    if (!res.ok) throw new Error(`explorer ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const slim = {
      white: data.white,
      draws: data.draws,
      black: data.black,
      opening: data.opening,
      moves: data.moves.map((m) => ({ uci: m.uci, san: m.san, white: m.white, draws: m.draws, black: m.black, averageRating: m.averageRating })),
    };
    writeFileSync(file, JSON.stringify(slim));
    await sleep(400);
    return slim;
  }
  throw new Error('explorer: превышено число попыток');
}

// ---------- сборка ----------
async function build(id) {
  const src = JSON.parse(readFileSync(path.join(LINES_DIR, `${id}.lines.json`), 'utf8'));
  const lineById = new Map(src.lines.map((l) => [l.id, l]));
  const nodes = {}; // key -> {moves: Map<uci, move>}
  const start = fenKey(new Chess().fen());
  const problems = [];

  for (const [vi, v] of src.variations.entries()) {
    const chess = new Chess();
    const tags = v.lines;
    for (const t of tags) if (!lineById.has(t)) throw new Error(`Вариант #${vi}: неизвестная линия ${t}`);
    const plies = parsePgn(v.pgn);
    const sans = [];
    for (const p of plies) {
      const key = fenKey(chess.fen());
      let mv;
      try {
        mv = chess.move(p.san);
      } catch {
        throw new Error(`Вариант #${vi} (${tags}): нелегальный ход ${p.san} после ${sans.join(' ')}`);
      }
      sans.push(mv.san);
      const uci = mv.from + mv.to + (mv.promotion || '');
      const node = (nodes[key] ||= { moves: new Map() });
      let edge = node.moves.get(uci);
      if (!edge) {
        edge = { san: mv.san, uci, to: fenKey(chess.fen()), comment: '', lines: new Set(), ply: sans.length };
        node.moves.set(uci, edge);
      }
      if (p.comment && !edge.comment) edge.comment = p.comment;
      for (const t of tags) edge.lines.add(t);
    }
    // mainPath линии = первый вариант с этой линией
    for (const t of tags) {
      const line = lineById.get(t);
      if (!line.mainPath) line.mainPath = sans;
    }
  }

  // статистика
  let statsAvailable = false;
  let fetched = 0;
  const explorerByKey = {};
  for (const key of Object.keys(nodes)) {
    const data = await explorer(key + ' 0 1');
    if (!data) continue;
    statsAvailable = true;
    fetched++;
    explorerByKey[key] = data;
    const total = data.moves.reduce((a, m) => a + m.white + m.draws + m.black, 0) || 1;
    for (const edge of nodes[key].moves.values()) {
      const m = data.moves.find((x) => sanKey(x.san) === sanKey(edge.san));
      if (m) {
        const games = m.white + m.draws + m.black;
        edge.stats = {
          games,
          share: +(games / total).toFixed(3),
          white: +(m.white / games).toFixed(3),
          draws: +(m.draws / games).toFixed(3),
          black: +(m.black / games).toFixed(3),
        };
      } else {
        edge.stats = { games: 0, share: 0 };
      }
    }
  }
  if (TOKEN) console.log(`explorer: запрошено/из кэша ${fetched} позиций`);

  // ---------- автодополнение: популярные ответы соперника, не покрытые курируемыми вариантами ----------
  // Релевантность: в основных линиях — ходы обеих сторон; в служебной линии за чёрных (anti) — только ходы белых;
  // в служебной линии за белых (sidelines) — только ходы чёрных. Достраиваем главную линию базы на `plies` полуходов.
  const ax = src.autoExtend;
  const autoAdded = [];
  if (ax && statsAvailable) {
    const lineSide = new Map(src.lines.map((l) => [l.id, l.always ? l.side : 'both']));
    const queue = Object.keys(nodes).filter((k) => nodes[k].moves.size);
    const seen = new Set(queue);
    while (queue.length) {
      const key = queue.shift();
      const node = nodes[key];
      const ply = Math.min(...[...node.moves.values()].map((m) => m.ply)) - 1;
      if (ply < 2 || ply >= ax.maxPly) continue;
      const data = explorerByKey[key] || (explorerByKey[key] = await explorer(key + ' 0 1'));
      if (!data) continue;
      const stm = sideToMove(key);
      const tags = new Set([...node.moves.values()].flatMap((m) => [...m.lines]));
      const relTags = [...tags].filter((t) => lineSide.get(t) === 'both' || lineSide.get(t) !== stm);
      if (!relTags.length) continue;
      const total = data.moves.reduce((a, m) => a + m.white + m.draws + m.black, 0) || 1;
      for (const m of data.moves) {
        const games = m.white + m.draws + m.black;
        if (games < ax.minGames || games / total < ax.minShare) continue;
        if ([...node.moves.values()].some((e) => sanKey(e.san) === sanKey(m.san))) continue;
        // достраиваем линию
        const chess = new Chess(key + ' 0 1');
        let curKey = key;
        let curData = data;
        let san = m.san;
        let depth = 0;
        while (san && depth < ax.plies) {
          const mv = chess.move(san);
          if (!mv) break;
          const uci = mv.from + mv.to + (mv.promotion || '');
          const nextKey = fenKey(chess.fen());
          const cur = (nodes[curKey] ||= { moves: new Map() });
          let edge = [...cur.moves.values()].find((e) => e.uci === uci);
          if (!edge) {
            const em = curData.moves.find((x) => sanKey(x.san) === sanKey(mv.san));
            const g = em ? em.white + em.draws + em.black : 0;
            const t = curData.moves.reduce((a, x) => a + x.white + x.draws + x.black, 0) || 1;
            edge = { san: mv.san, uci, to: nextKey, comment: '', lines: new Set(relTags), ply: ply + depth + 1, auto: true,
              stats: { games: g, share: +(g / t).toFixed(3), white: em ? +(em.white / g).toFixed(3) : 0, draws: em ? +(em.draws / g).toFixed(3) : 0, black: em ? +(em.black / g).toFixed(3) : 0 } };
            cur.moves.set(uci, edge);
            autoAdded.push({ key: curKey, edge });
          } else {
            for (const t of relTags) edge.lines.add(t);
            if (nodes[nextKey]) break; // влились в существующий узел (транспозиция)
          }
          curKey = nextKey;
          curData = explorerByKey[curKey] || (explorerByKey[curKey] = await explorer(curKey + ' 0 1'));
          if (!curData) break;
          if (!seen.has(curKey)) { seen.add(curKey); }
          san = curData.moves[0]?.san;
          depth++;
        }
      }
    }
    console.log(`автодополнение: добавлено ${autoAdded.length} ходов`);
  }

  // сериализация: ходы в узле сортируем по числу партий
  const outNodes = {};
  for (const [key, node] of Object.entries(nodes)) {
    const moves = [...node.moves.values()].sort((a, b) => (b.stats?.games ?? 0) - (a.stats?.games ?? 0));
    outNodes[key] = {
      moves: moves.map((m) => ({
        san: m.san,
        uci: m.uci,
        to: m.to,
        comment: m.comment,
        lines: [...m.lines],
        ...(m.stats ? { stats: m.stats } : {}),
        ...(m.auto ? { auto: true } : {}),
      })),
    };
  }
  const out = {
    id: src.id,
    name: src.name,
    eco: src.eco,
    description: src.description || '',
    generated: new Date().toISOString().slice(0, 10),
    statsSource: statsAvailable ? 'lichess-masters' : null,
    start,
    lines: src.lines.map((l) => ({
      id: l.id,
      name: l.name,
      eco: l.eco || '',
      side: l.side || 'both',
      priority: l.priority ?? 99,
      always: !!l.always,
      description: l.description || '',
      mainPath: l.mainPath || [],
    })),
    nodes: outNodes,
  };
  writeFileSync(path.join(OUT_DIR, `${id}.json`), JSON.stringify(out, null, 1));

  // ---------- отчёт ----------
  const rep = [];
  rep.push(`# Отчёт сборки: ${src.name} (${id})`, '');
  rep.push(`- Узлов: ${Object.keys(nodes).length}, рёбер: ${Object.values(nodes).reduce((a, n) => a + n.moves.size, 0)}, вариантов: ${src.variations.length}`);
  rep.push(`- Статистика Lichess Masters: ${statsAvailable ? 'есть' : 'НЕТ (нет LICHESS_TOKEN и кэша) — ходы не верифицированы по базе'}`);
  rep.push('');
  if (statsAvailable) {
    const weak = [];
    const uncovered = [];
    for (const [key, node] of Object.entries(nodes)) {
      const data = explorerByKey[key];
      if (!data) continue;
      const total = data.moves.reduce((a, m) => a + m.white + m.draws + m.black, 0) || 1;
      const ply = Math.min(...[...node.moves.values()].map((m) => m.ply)) - 1;
      const pathSan = pathTo(key);
      for (const edge of node.moves.values()) {
        if (!edge.stats || edge.stats.share < MIN_SHARE) weak.push(`- ${pathSan} **${edge.san}** — доля ${((edge.stats?.share ?? 0) * 100).toFixed(1)} % (${edge.stats?.games ?? 0} партий) [${[...edge.lines]}]`);
      }
      if (ply >= 2 && ply < MAX_REPORT_PLY) {
        for (const m of data.moves) {
          const games = m.white + m.draws + m.black;
          const share = games / total;
          if (share >= UNCOVERED_SHARE && ![...node.moves.values()].some((e) => sanKey(e.san) === sanKey(m.san))) {
            const who = sideToMove(key) === 'white' ? 'белые' : 'чёрные';
            uncovered.push(`- ${pathSan} → **${m.san}** (${who}, ${(share * 100).toFixed(0)} %, ${games} партий) — не покрыт графом`);
          }
        }
      }
    }
    rep.push(`## Ходы с долей < ${MIN_SHARE * 100} % в базе мастеров (проверить!)`, '', ...(weak.length ? weak : ['- нет']), '');
    rep.push(`## Популярные (≥ ${UNCOVERED_SHARE * 100} %) ответы, не покрытые графом`, '', ...(uncovered.length ? uncovered : ['- нет']), '');
  }
  if (autoAdded.length) {
    rep.push(`## Автодополненные ходы (без аннотаций) — ${autoAdded.length}`, '');
    for (const { key, edge } of autoAdded) rep.push(`- ${pathTo(key)} **${edge.san}** (${(edge.stats.share * 100).toFixed(0)} %, ${edge.stats.games}) [${[...edge.lines]}]`);
    rep.push('');
  }
  rep.push('## Линии', '');
  for (const l of out.lines) {
    rep.push(`### ${l.name} (${l.eco || '—'}) — side: ${l.side}, priority: ${l.priority}${l.always ? ', always' : ''}`);
    rep.push('', '`' + pgnString(l.mainPath) + '`', '');
    if (statsAvailable) {
      // таблица ходов линии с долей/результатом
      rep.push('| № | Ход | Доля | Белые/Ничьи/Чёрные | Партий |', '|---|---|---|---|---|');
      let chess = new Chess();
      l.mainPath.forEach((san, i) => {
        const key = fenKey(chess.fen());
        const mv = chess.move(san);
        const edge = nodes[key].moves.get(mv.from + mv.to + (mv.promotion || ''));
        const s = edge.stats;
        rep.push(`| ${i % 2 === 0 ? Math.floor(i / 2) + 1 + '.' : '…'} | ${san} | ${s ? (s.share * 100).toFixed(0) + ' %' : '—'} | ${s && s.games ? `${(s.white * 100).toFixed(0)}/${(s.draws * 100).toFixed(0)}/${(s.black * 100).toFixed(0)}` : '—'} | ${s?.games ?? '—'} |`);
      });
      rep.push('');
    }
  }
  writeFileSync(path.join(REPORT_DIR, `${id}.md`), rep.join('\n'));
  console.log(`✔ ${id}: ${Object.keys(nodes).length} узлов, ${out.lines.length} линий → data/openings/${id}.json, tools/report/${id}.md`);
  if (!statsAvailable) console.warn('⚠ статистика Lichess недоступна: задайте LICHESS_TOKEN и пересоберите');

  // путь (SAN) до позиции — для читаемости отчёта (поиск в ширину от старта)
  function pathTo(targetKey) {
    const prev = new Map([[start, null]]);
    const q = [start];
    while (q.length) {
      const k = q.shift();
      if (k === targetKey) break;
      for (const e of nodes[k]?.moves.values() ?? []) {
        if (!prev.has(e.to)) {
          prev.set(e.to, { k, san: e.san });
          q.push(e.to);
        }
      }
    }
    const sans = [];
    let k = targetKey;
    while (prev.get(k)) {
      sans.unshift(prev.get(k).san);
      k = prev.get(k).k;
    }
    return pgnString(sans) || '(старт)';
  }
}

// Рокировка у Lichess в UCI записывается как e1h1, поэтому сверяем по SAN.
const sanKey = (san) => san.replace(/[+#!?]/g, '');

function pgnString(sans) {
  return sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.${s}` : s)).join(' ');
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(LINES_DIR).filter((f) => f.endsWith('.lines.json')).map((f) => f.replace('.lines.json', ''));
for (const id of ids) await build(id);
