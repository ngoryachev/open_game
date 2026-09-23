import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Chess } from '../vendor/chess.js';
import { createTrainer, selectLines } from '../js/trainer.js';
import { fenKey, keyToFen } from '../js/fen.js';

const opening = JSON.parse(readFileSync(new URL('../data/openings/sicilian.json', import.meta.url), 'utf8'));

test('граф целостен: все ссылки to ведут на узлы или листья, старт существует', () => {
  assert.ok(opening.nodes[opening.start]);
  for (const [key, node] of Object.entries(opening.nodes)) {
    const chess = new Chess(keyToFen(key));
    for (const m of node.moves) {
      const mv = chess.move(m.san);
      assert.equal(mv.from + mv.to + (mv.promotion || ''), m.uci, `uci ${key} ${m.san}`);
      assert.equal(fenKey(chess.fen()), m.to, `to ${key} ${m.san}`);
      chess.undo();
      assert.ok(m.lines.length > 0, `ход без линий: ${m.san}`);
    }
  }
});

test('mainPath каждой линии легален и проходит по графу', () => {
  for (const line of opening.lines) {
    const chess = new Chess();
    let key = opening.start;
    for (const san of line.mainPath) {
      const mv = chess.move(san);
      assert.ok(mv, `${line.id}: нелегальный ${san}`);
      const edge = opening.nodes[key].moves.find((m) => m.san === san);
      assert.ok(edge, `${line.id}: нет ребра ${san}`);
      assert.ok(edge.lines.includes(line.id));
      key = edge.to;
    }
  }
});

test('selectLines: top-K по priority плюс служебные линии', () => {
  const b1 = selectLines(opening, 'black', 1);
  assert.deepEqual(b1.map((l) => l.id), ['najdorf', 'anti']);
  const w2 = selectLines(opening, 'white', 2);
  assert.deepEqual(w2.map((l) => l.id), ['najdorf', 'dragon', 'sidelines']);
});

test('чёрные, K=1: книжный ход принимается, небуквенный — ошибка с ожидаемыми ходами', () => {
  const t = createTrainer({ opening, side: 'black', linesCount: 1, rng: () => 0 });
  assert.equal(t.isUserTurn(), false);
  const w1 = t.opponentMove();
  assert.equal(w1.san, 'e4');
  assert.ok(t.userMove('c7c5', 'c5').ok);
  t.opponentMove(); // 2.Nf3 (или другой ход из графа)
  const node = opening.nodes[t.state.key];
  if (node.moves.some((m) => m.san === 'd6')) {
    // при выборе только Найдорфа 2…Nc6 не книжный, хотя и помечен служебной линией
    const res = t.userMove('b8c6', 'Nc6');
    assert.equal(res.ok, false);
    assert.equal(t.state.status, 'fail');
    assert.deepEqual(res.expected.map((m) => m.san), ['d6']);
  }
});

test('чёрные: против 2.c3 принимаются ходы служебной линии', () => {
  const t = createTrainer({ opening, side: 'black', linesCount: 1 });
  t.opponentMove();
  t.userMove('c7c5', 'c5');
  // вручную переводим в позицию после 2.c3
  const c3 = opening.nodes[t.state.key].moves.find((m) => m.san === 'c3');
  assert.ok(c3, 'в графе есть 2.c3');
  const book = t.bookMoves(c3.to, 'user');
  assert.ok(book.some((m) => m.san === 'Nf6'));
});

const playThrough = (t) => {
  while (t.state.status === 'playing') {
    if (t.isUserTurn()) {
      const mv = t.bookMoves()[0];
      t.userMove(mv.uci, mv.san);
    } else t.opponentMove();
  }
};

test('по умолчанию линия играется до последнего книжного хода', () => {
  const t = createTrainer({ opening, side: 'white', linesCount: 4, rng: () => 0 });
  playThrough(t);
  assert.equal(t.state.status, 'success');
  assert.equal(t.state.reason, 'book-end');
  assert.equal(t.bookMoves().length, 0, 'партия закончилась именно из-за исчерпания книжных ходов');
  // Знаменатель прогресса считается по mainPath, а соперник мог уйти в более короткую ветку графа,
  // поэтому сверяем не равенство с userMovesTotal(), а то, что линия длиннее прежней глубины по умолчанию (8).
  assert.ok(t.state.userMoves > 8, `линия обрывается слишком рано: ${t.state.userMoves}`);
});

test('при явном ограничении успех наступает после depth ходов пользователя', () => {
  const t = createTrainer({ opening, side: 'white', depth: 3, linesCount: 4, rng: () => 0 });
  playThrough(t);
  assert.equal(t.state.status, 'success');
  assert.equal(t.state.reason, 'depth');
  assert.equal(t.state.userMoves, 3);
});

// Последовательность rng, повторяющаяся по кругу: воспроизводимый ход партии в тестах.
const cycle = (...xs) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};

// ui.js renderStatus: знаменатель прогресса — явное ограничение, иначе длина самой длинной возможной линии.
const progressTotal = (t) => t.depth ?? t.userMovesTotal();

test('ограничение длиннее линии не мешает завершению по книге', () => {
  const t = createTrainer({ opening, side: 'white', depth: 15, linesCount: 4, rng: () => 0 });
  playThrough(t);
  assert.equal(t.state.status, 'success');
  assert.equal(t.state.reason, 'book-end', 'линия кончилась раньше ограничения — причина должна быть book-end');
  assert.ok(t.state.userMoves < 15, `ожидался обрыв по книге раньше 15 ходов: ${t.state.userMoves}`);
});

test('прогресс: при снятом ограничении знаменатель не меньше числа сделанных ходов', () => {
  const t = createTrainer({ opening, side: 'white', linesCount: 1, rng: cycle(0.55, 0.5) });
  const bad = [];
  while (t.state.status === 'playing') {
    if (t.isUserTurn()) {
      const mv = t.bookMoves()[0];
      t.userMove(mv.uci, mv.san);
    } else t.opponentMove();
    const total = progressTotal(t);
    if (t.state.userMoves > total) bad.push(`${t.state.userMoves} / ${total}`);
  }
  assert.deepEqual(bad, [], `прогресс показывает больше ходов, чем всего: ${bad.join(', ')}`);
});

test('прогресс: знаменатель не обнуляется, когда совместимых линий не осталось', () => {
  const t = createTrainer({ opening, side: 'white', linesCount: 2, rng: cycle(0.9, 0) });
  const zero = [];
  while (t.state.status === 'playing') {
    if (t.isUserTurn()) {
      const mv = t.bookMoves()[0];
      t.userMove(mv.uci, mv.san);
    } else t.opponentMove();
    if (progressTotal(t) === 0) zero.push(t.state.userMoves);
  }
  assert.deepEqual(zero, [], `знаменатель прогресса обнулился после ходов пользователя: ${zero.join(', ')}`);
});

test('соперник выбирает ход с весом по партиям', () => {
  const t = createTrainer({ opening, side: 'black', linesCount: 4, rng: () => 0.999 });
  const mv = t.opponentMove();
  assert.ok(mv);
});

test('после ошибки принимается только правильный ход, и тренировка продолжается', () => {
  const t = createTrainer({ opening, side: 'black', linesCount: 1, rng: () => 0 });
  t.opponentMove();
  assert.equal(t.userMove('h7h6', 'h6').ok, false);
  assert.equal(t.state.status, 'fail');
  assert.equal(t.state.mistakes, 1);
  assert.equal(t.userMove('a7a6', 'a6').ok, false); // снова мимо — ошибка не удваивается
  assert.equal(t.state.mistakes, 1);
  const res = t.userMove('c7c5', 'c5');
  assert.equal(res.ok, true);
  assert.equal(res.recovered, true);
  assert.equal(t.state.status, 'playing');
  assert.equal(t.state.userMoves, 1);
});

const traps = JSON.parse(readFileSync(new URL('../data/openings/traps.json', import.meta.url), 'utf8'));

test('ловушки: граф легален, по 10 линий за каждую сторону, mainPath проходит по графу', () => {
  for (const side of ['white', 'black']) assert.equal(traps.lines.filter((l) => l.side === side).length, 10);
  for (const [key, node] of Object.entries(traps.nodes)) {
    const chess = new Chess(keyToFen(key));
    for (const m of node.moves) {
      const mv = chess.move(m.san);
      assert.equal(fenKey(chess.fen()), m.to, `to ${key} ${m.san}`);
      chess.undo();
      assert.equal(mv.from + mv.to + (mv.promotion || ''), m.uci);
    }
  }
  for (const line of traps.lines) {
    let key = traps.start;
    for (const san of line.mainPath) {
      const edge = traps.nodes[key].moves.find((m) => m.san === san);
      assert.ok(edge?.lines.includes(line.id), `${line.id}: нет ребра ${san}`);
      key = edge.to;
    }
    // последний ход линии делает сторона, которая ставит ловушку
    assert.equal(line.mainPath.length % 2 === 1 ? 'white' : 'black', line.side, line.id);
  }
});

test('ловушки: соперник выбирает ходы по числу линий, каждая ловушка проходится до конца', () => {
  assert.equal(traps.weighting, 'lines');
  for (const side of ['white', 'black']) {
    const reached = new Set();
    for (let i = 0; i < 200; i++) {
      const t = createTrainer({ opening: traps, side, linesCount: 10 });
      while (t.state.status === 'playing') {
        if (t.isUserTurn()) {
          const moves = t.bookMoves();
          const mv = moves[Math.floor(Math.random() * moves.length)];
          assert.ok(t.userMove(mv.uci, mv.san).ok);
        } else t.opponentMove();
      }
      assert.equal(t.state.status, 'success');
      assert.equal(t.state.reason, 'book-end');
      for (const l of t.currentLines()) reached.add(l.id);
    }
    assert.equal(reached.size, 10, `${side}: пройдены не все ловушки: ${[...reached]}`);
  }
});

test('ловушки: явное ограничение глубины завершает партию по depth', () => {
  for (const line of traps.lines) {
    const t = createTrainer({ opening: { ...traps, lines: [line] }, side: line.side, depth: 3, linesCount: 1, rng: () => 0 });
    playThrough(t);
    assert.equal(t.state.status, 'success', line.id);
    assert.equal(t.state.reason, 'depth', `${line.id}: ограничение глубины должно работать и для ловушек`);
    assert.equal(t.state.userMoves, 3, line.id);
  }
});

test('ловушки: каждая из 20 ловушек доигрывается до последнего хода линии', () => {
  assert.equal(traps.lines.length, 20);
  for (const line of traps.lines) {
    let r = 0;
    const opening = { ...traps, lines: [line] };
    const t = createTrainer({ opening, side: line.side, linesCount: 1, rng: () => r });
    for (const san of line.mainPath) {
      assert.equal(t.state.status, 'playing', `${line.id}: партия закончилась до ${san}`);
      const moves = t.bookMoves();
      if (t.isUserTurn()) {
        const mv = moves.find((m) => m.san === san);
        assert.ok(mv, `${line.id}: нет хода ${san}`);
        assert.ok(t.userMove(mv.uci, mv.san).ok);
      } else {
        const k = moves.findIndex((m) => m.san === san);
        assert.ok(k >= 0, `${line.id}: нет хода соперника ${san}`);
        r = (k + 0.5) / moves.length;
        assert.equal(t.opponentMove()?.san, san, line.id);
      }
    }
    assert.equal(t.state.status, 'success', line.id);
    assert.equal(t.state.reason, 'book-end', line.id);
    assert.equal(t.state.history.length, line.mainPath.length, line.id);
    assert.equal(t.state.history.at(-1).san, line.mainPath.at(-1), line.id);
    assert.equal(t.userMovesTotal(), t.state.userMoves, line.id);
  }
});

// ---------- поведение «до конца линии» по умолчанию ----------

test('флаг playToEnd убран из данных, исходников и API тренажёра', () => {
  for (const o of [opening, traps]) assert.equal('playToEnd' in o, false, `${o.id}: playToEnd остался в графе`);
  const t = createTrainer({ opening: traps, side: 'white', linesCount: 10, rng: () => 0 });
  assert.equal('playToEnd' in t, false, 'тренажёр всё ещё отдаёт playToEnd');
  for (const f of ['tools/lines/traps.lines.json', 'tools/build-opening.mjs', 'js/trainer.js', 'js/app.js', 'js/ui.js', 'index.html']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.equal(src.includes('playToEnd'), false, `${f}: упоминание playToEnd`);
  }
});

test('без depth ограничения нет: trainer.depth === null (ui берёт userMovesTotal)', () => {
  const t = createTrainer({ opening, side: 'white', linesCount: 4, rng: () => 0 });
  assert.equal(t.depth, null);
  assert.equal(progressTotal(t), t.userMovesTotal());
  const limited = createTrainer({ opening, side: 'white', depth: 5, linesCount: 4, rng: () => 0 });
  assert.equal(progressTotal(limited), 5);
});

// Детерминированный ГПСЧ: воспроизводимые прогоны без Math.random.
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('без ограничения любая партия кончается по книге, а прогресс сходится к 100 %', () => {
  for (const [name, op] of [['sicilian', opening], ['traps', traps]]) {
    for (const side of ['white', 'black']) {
      for (const linesCount of [1, 4, 10]) {
        for (let s = 0; s < 40; s++) {
          const t = createTrainer({ opening: op, side, linesCount, rng: seeded(s * 31 + linesCount) });
          const tag = `${name}/${side}/K=${linesCount}/seed=${s}`;
          let guard = 0;
          while (t.state.status === 'playing') {
            assert.ok(guard++ < 200, `${tag}: партия не заканчивается`);
            if (t.isUserTurn()) {
              const mv = t.bookMoves()[0];
              t.userMove(mv.uci, mv.san);
            } else t.opponentMove();
            assert.ok(t.state.userMoves <= progressTotal(t), `${tag}: ${t.state.userMoves} / ${progressTotal(t)}`);
          }
          assert.equal(t.state.status, 'success', tag);
          assert.equal(t.state.reason, 'book-end', tag);
          assert.equal(t.bookMoves().length, 0, `${tag}: остались книжные ходы`);
          assert.equal(t.userMovesTotal(), t.state.userMoves, `${tag}: прогресс не дошёл ровно до 100 %`);
        }
      }
    }
  }
});

test('явное ограничение работает для обеих сторон и на границе depth = 1', () => {
  for (const side of ['white', 'black']) {
    for (const depth of [1, 2, 5]) {
      const t = createTrainer({ opening, side, depth, linesCount: 4, rng: seeded(depth) });
      playThrough(t);
      assert.equal(t.state.status, 'success');
      assert.equal(t.state.reason, 'depth', `${side}/depth=${depth}`);
      assert.equal(t.state.userMoves, depth, `${side}/depth=${depth}`);
      assert.equal(progressTotal(t), depth, `${side}/depth=${depth}: знаменатель прогресса — само ограничение`);
    }
  }
});

test('userMovesTotal не зацикливается на графе с повтором позиции', () => {
  // a -> b -> c -> d -> c (повтор позиции) и c -> e (конец книги)
  const node = (key, moves) => [key, { moves }];
  const mv = (san, to) => ({ san, uci: san, to, lines: ['x'], comment: '' });
  const cyclic = {
    id: 'cyclic',
    start: 'a w - -',
    lines: [{ id: 'x', name: 'x', side: 'white', priority: 1, mainPath: [] }],
    nodes: Object.fromEntries([
      node('a w - -', [mv('a1', 'b b - -')]),
      node('b b - -', [mv('b1', 'c w - -')]),
      node('c w - -', [mv('c1', 'd b - -'), mv('c2', 'e b - -')]),
      node('d b - -', [mv('d1', 'c w - -')]),
      node('e b - -', []),
    ]),
  };
  const t = createTrainer({ opening: cyclic, side: 'white', linesCount: 1, rng: () => 0 });
  const total = t.userMovesTotal();
  assert.equal(Number.isFinite(total), true, 'userMovesTotal должен быть конечным при повторе позиции');
  assert.ok(total >= 2, `ожидалось минимум 2 хода пользователя, получено ${total}`);
});

test('слайдер глубины: разметка и константы app.js согласованы, поле не прячется', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const slider = html.match(/<input[^>]*id="depth"[^>]*>/)?.[0];
  assert.ok(slider, 'в index.html нет слайдера глубины');
  const attr = (n) => +slider.match(new RegExp(`${n}="(\\d+)"`))?.[1];
  const depthMax = +app.match(/DEPTH_MAX\s*=\s*(\d+)/)?.[1];
  assert.equal(Number.isFinite(depthMax), true, 'в app.js нет DEPTH_MAX');
  assert.equal(attr('max'), depthMax + 1, 'крайнее правое положение слайдера должно означать «до конца»');
  assert.equal(attr('value'), attr('max'), 'по умолчанию слайдер стоит в положении «до конца линии»');
  assert.ok(attr('min') >= 1 && attr('min') < depthMax);
  assert.equal(html.includes('depth-field'), false, 'поле глубины больше не прячется и не нуждается в id');
  assert.equal(app.includes('depth-field'), false, 'app.js всё ещё прячет поле глубины');
  assert.ok(/id="depth-value"[^<]*>до конца линии</.test(html), 'подпись по умолчанию — «до конца линии»');
});
