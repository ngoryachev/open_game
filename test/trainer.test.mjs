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
  const t = createTrainer({ opening, side: 'black', depth: 8, linesCount: 1, rng: () => 0 });
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
  const t = createTrainer({ opening, side: 'black', depth: 6, linesCount: 1 });
  t.opponentMove();
  t.userMove('c7c5', 'c5');
  // вручную переводим в позицию после 2.c3
  const c3 = opening.nodes[t.state.key].moves.find((m) => m.san === 'c3');
  assert.ok(c3, 'в графе есть 2.c3');
  const book = t.bookMoves(c3.to, 'user');
  assert.ok(book.some((m) => m.san === 'Nf6'));
});

test('успех после depth ходов пользователя', () => {
  const t = createTrainer({ opening, side: 'white', depth: 3, linesCount: 4, rng: () => 0 });
  const play = () => {
    while (t.state.status === 'playing') {
      if (t.isUserTurn()) {
        const mv = t.bookMoves()[0];
        t.userMove(mv.uci, mv.san);
      } else t.opponentMove();
    }
  };
  play();
  assert.equal(t.state.status, 'success');
  assert.equal(t.state.userMoves, 3);
});

test('соперник выбирает ход с весом по партиям', () => {
  const t = createTrainer({ opening, side: 'black', depth: 8, linesCount: 4, rng: () => 0.999 });
  const mv = t.opponentMove();
  assert.ok(mv);
});

test('после ошибки принимается только правильный ход, и тренировка продолжается', () => {
  const t = createTrainer({ opening, side: 'black', depth: 3, linesCount: 1, rng: () => 0 });
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
