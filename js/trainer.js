// Чистая логика тренажёра: ходит по графу дебюта, без DOM и без chess.js.
// Легальность ходов гарантирует сборщик графа (tools/build-opening.mjs) и доска (chessground + chess.js).
import { sideToMove } from './fen.js';

const other = (s) => (s === 'white' ? 'black' : 'white');

/**
 * Выбор линий для стороны: top-K по priority среди линий, доступных за эту сторону.
 */
export function selectLines(opening, side, count) {
  const forSide = opening.lines.filter((l) => l.side === 'both' || l.side === side);
  const main = forSide
    .filter((l) => !l.always)
    .sort((a, b) => a.priority - b.priority)
    .slice(0, count);
  // Служебные линии (always) — например, ответы на анти-сицилианки — включаются всегда и не занимают слот.
  const always = forSide.filter((l) => l.always);
  return [...main, ...always];
}

/**
 * @param {object} opts
 * @param {object} opts.opening   — граф дебюта (data/openings/*.json)
 * @param {'white'|'black'} opts.side — сторона пользователя
 * @param {number|null} [opts.depth] — необязательный ограничитель числа ходов пользователя;
 *                                  null (по умолчанию) = играть до последнего книжного хода
 * @param {number} opts.linesCount — сколько линий (top-K по priority) задействовать
 * @param {() => number} [opts.rng] — генератор случайных чисел (для тестов)
 */
export function createTrainer({ opening, side, depth = null, linesCount, rng = Math.random }) {
  const lines = selectLines(opening, side, linesCount);
  const mainIds = new Set(lines.filter((l) => !l.always).map((l) => l.id));
  const alwaysIds = new Set(lines.filter((l) => l.always).map((l) => l.id));
  if (mainIds.size + alwaysIds.size === 0) throw new Error(`Нет линий за ${side} в дебюте ${opening.id}`);

  const state = {
    key: opening.start,
    history: [], // {san, uci, comment, by: 'user'|'opponent', lines: []}
    status: 'playing', // playing | success | fail
    expected: [], // книжные ходы, которые ожидались при ошибке
    wrong: null, // {uci, san}
    userMoves: 0,
    mistakes: 0, // число ошибок за попытку
    reason: null, // 'depth' | 'book-end' при success
  };

  const tagged = (m, ids) => (m.lines || []).some((id) => ids.has(id));

  /**
   * Книжные ходы в позиции.
   * Для пользователя: ходы выбранных основных линий; служебные (always) линии — только если
   * основных ходов в позиции нет (соперник уклонился от главных систем).
   * Для соперника: объединение основных и служебных — он может уклоняться как угодно.
   */
  function bookMoves(key = state.key, role = sideToMove(key) === side ? 'user' : 'opponent') {
    const node = opening.nodes[key];
    if (!node) return [];
    const main = node.moves.filter((m) => tagged(m, mainIds));
    if (role === 'user') return main.length ? main : node.moves.filter((m) => tagged(m, alwaysIds));
    return node.moves.filter((m) => tagged(m, mainIds) || tagged(m, alwaysIds));
  }

  function toMove() {
    return sideToMove(state.key);
  }

  function currentLines() {
    // Линии, совместимые со всем сыгранным путём (сужаются по мере игры).
    let ids = new Set([...mainIds, ...alwaysIds]);
    for (const h of state.history) {
      if (h.lines && h.lines.length) ids = new Set(h.lines.filter((id) => ids.has(id)));
    }
    return lines.filter((l) => ids.has(l.id));
  }

  // key → максимум оставшихся ходов пользователя из этой позиции; null = узел в текущем стеке обхода.
  // Кэш живёт всю попытку: bookMoves() зависит только от позиции и выбранных линий, а они не меняются.
  const remainingMemo = new Map();

  /** Максимум ходов пользователя, которые ещё можно сделать из позиции key, — по графу книги. */
  function remainingUserMoves(key) {
    if (remainingMemo.has(key)) return remainingMemo.get(key) ?? 0; // повтор позиции (цикл) — ветку не удлиняет
    remainingMemo.set(key, null);
    const add = sideToMove(key) === side ? 1 : 0;
    let best = 0;
    for (const m of bookMoves(key)) best = Math.max(best, add + remainingUserMoves(m.to));
    remainingMemo.set(key, best);
    return best;
  }

  /**
   * Число ходов пользователя в самой длинной из ещё возможных линий: сделанные плюс оставшиеся по графу.
   * Считается по графу, а не по mainPath линий, поэтому значение корректно и когда партия ушла в ветку
   * вне mainPath: оно никогда не меньше state.userMoves и равно ему в конце книги (прогресс-бар доходит
   * ровно до 100 %). Раньше знаменатель брался из mainPath ещё совместимых линий и мог оказаться меньше
   * числа сделанных ходов или обнулиться, когда совместимых линий не осталось.
   */
  function userMovesTotal() {
    return state.userMoves + remainingUserMoves(state.key);
  }

  function apply(move, by) {
    state.history.push({ san: move.san, uci: move.uci, comment: move.comment || '', by, lines: move.lines || [] });
    state.key = move.to;
    if (by === 'user') state.userMoves += 1;
    checkEnd();
  }

  function checkEnd() {
    if (state.status !== 'playing') return;
    if (depth != null && state.userMoves >= depth) {
      state.status = 'success';
      state.reason = 'depth';
      return;
    }
    if (bookMoves().length === 0) {
      state.status = 'success';
      state.reason = 'book-end';
    }
  }

  /** Ход соперника: случайный книжный ход с весом по числу партий. */
  function opponentMove() {
    if (state.status !== 'playing' || toMove() !== other(side)) return null;
    const moves = bookMoves();
    if (!moves.length) {
      checkEnd();
      return null;
    }
    // Вес: число партий из базы мастеров; без статистики — сколько линий проходит через ход (прокси популярности).
    // weighting: 'lines' (ловушки) — только число выбранных линий через ход: ошибочные ходы у мастеров редки,
    // а каждая линия должна выпадать примерно одинаково часто.
    const byLines = (m) => (m.lines || []).filter((id) => mainIds.has(id) || alwaysIds.has(id)).length;
    const weights = moves.map((m) =>
      Math.max(1, opening.weighting === 'lines' ? byLines(m) : m.stats?.games ?? (m.lines?.length ?? 1) ** 2),
    );
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    let pick = moves[moves.length - 1];
    for (let i = 0; i < moves.length; i++) {
      r -= weights[i];
      if (r < 0) {
        pick = moves[i];
        break;
      }
    }
    apply(pick, 'opponent');
    return pick;
  }

  /**
   * Ход пользователя по UCI. Возвращает {ok, move|expected}.
   * После ошибки (status = fail) принимается только один из ожидаемых ходов — тогда тренировка продолжается
   * (recovered: true), а ошибка остаётся в счётчике mistakes.
   */
  function userMove(uci, san = uci) {
    if (!['playing', 'fail'].includes(state.status) || toMove() !== side) return { ok: false, ignored: true };
    const moves = bookMoves();
    const hit = moves.find((m) => m.uci === uci);
    if (hit) {
      const recovered = state.status === 'fail';
      state.status = 'playing';
      state.wrong = null;
      state.expected = [];
      apply(hit, 'user');
      return { ok: true, move: hit, recovered, alternatives: moves.filter((m) => m !== hit) };
    }
    if (state.status !== 'fail') state.mistakes += 1;
    state.status = 'fail';
    state.expected = moves;
    state.wrong = { uci, san };
    return { ok: false, expected: moves };
  }

  return {
    get state() {
      return state;
    },
    side,
    depth,
    lines,
    bookMoves,
    toMove,
    currentLines,
    userMovesTotal,
    opponentMove,
    userMove,
    isUserTurn: () => ['playing', 'fail'].includes(state.status) && toMove() === side,
  };
}
