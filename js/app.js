import { createBoard } from './board.js';
import { createTrainer, selectLines } from './trainer.js';
import { loadIndex, loadOpening } from './openings.js';
import { keyToFen } from './fen.js';
import { renderLinesPreview, renderStatus, renderMoves, renderFeedback, renderLineDump, statsLine } from './ui.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'open_game.settings';
const PROGRESS_KEY = 'open_game.progress';
const OPPONENT_DELAY = 450;

let index = [];
let opening = null;
let trainer = null;
let board = null;
let streak = 0;
let failRecorded = false;
let hintsUsed = 0;
let settings = loadSettings();

function loadSettings() {
  try {
    return { openingId: 'sicilian', side: 'white', depth: 8, linesCount: 4, comments: true, dests: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { openingId: 'sicilian', side: 'white', depth: 8, linesCount: 4, comments: true, dests: true };
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
  } catch {
    return {};
  }
}
function bumpProgress(lineIds, ok) {
  const p = loadProgress();
  for (const id of lineIds) {
    const k = `${opening.id}:${trainer.side}:${id}`;
    p[k] = p[k] || { ok: 0, fail: 0 };
    p[k][ok ? 'ok' : 'fail'] += 1;
  }
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
}

// ---------- экран настройки ----------
function readForm() {
  settings = {
    openingId: $('opening-select').value,
    side: document.querySelector('input[name=side]:checked').value,
    depth: +$('depth').value,
    linesCount: +$('lines-count').value,
    comments: $('opt-comments').checked,
    dests: $('opt-dests').checked,
  };
  $('depth-value').textContent = settings.depth;
  $('lines-value').textContent = settings.linesCount;
  saveSettings();
}

function fillForm() {
  const sel = $('opening-select');
  sel.innerHTML = '';
  for (const o of index) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = `${o.name} (${o.eco})`;
    sel.append(opt);
  }
  if (index.some((o) => o.id === settings.openingId)) sel.value = settings.openingId;
  document.querySelector(`input[name=side][value=${settings.side}]`).checked = true;
  $('depth').value = settings.depth;
  $('lines-count').value = settings.linesCount;
  $('opt-comments').checked = settings.comments;
  $('opt-dests').checked = settings.dests;
  $('depth-value').textContent = settings.depth;
  $('lines-value').textContent = settings.linesCount;
}

async function refreshPreview() {
  readForm();
  const entry = index.find((o) => o.id === settings.openingId);
  if (!entry) return;
  opening = await loadOpening(entry);
  $('lines-count').max = Math.max(1, opening.lines.filter((l) => l.side === 'both' || l.side === settings.side).length);
  if (settings.linesCount > +$('lines-count').max) {
    $('lines-count').value = $('lines-count').max;
    readForm();
  }
  renderLinesPreview(selectLines(opening, settings.side, settings.linesCount));
}

function showScreen(name) {
  $('screen-setup').hidden = name !== 'setup';
  $('screen-train').hidden = name !== 'train';
}

// ---------- тренировка ----------
function startTraining() {
  trainer = createTrainer({ opening, side: settings.side, depth: settings.depth, linesCount: settings.linesCount });
  failRecorded = false;
  hintsUsed = 0;
  board.setOrientation(settings.side);
  board.setShowDests(settings.dests);
  board.setShapes([]);
  board.setHighlights(new Map());
  renderFeedback();
  $('btn-show-line').textContent = 'Показать линию';
  $('moves-list').classList.remove('dump');
  syncBoard();
  showScreen('train');
  scheduleOpponent();
}

function syncBoard(lastMove) {
  board.setPosition(keyToFen(trainer.state.key), { lastMove, canMove: trainer.isUserTurn() });
  renderStatus(trainer, opening, streak);
  renderMoves(trainer.state.history, trainer.state.wrong);
  $('btn-hint').disabled = !trainer.isUserTurn();
}

function scheduleOpponent() {
  if (trainer.state.status !== 'playing' || trainer.isUserTurn()) {
    if (trainer.state.status === 'success') onSuccess();
    return;
  }
  const t = trainer;
  setTimeout(() => {
    if (t !== trainer) return; // тренировка перезапущена
    const mv = trainer.opponentMove();
    if (mv) {
      syncBoard([mv.uci.slice(0, 2), mv.uci.slice(2, 4)]);
      if (settings.comments) renderFeedback({ kind: 'info', title: `Соперник: ${mv.san}`, text: mv.comment, stats: statsLine(mv) });
    }
    if (trainer.state.status === 'success') onSuccess();
  }, OPPONENT_DELAY);
}

function onUserMove(uci, san) {
  const res = trainer.userMove(uci, san);
  if (res.ignored) return;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  if (res.ok) {
    board.setShapes([]);
    board.setHighlights(new Map([[to, 'ok-move']]));
    syncBoard([from, to]);
    renderFeedback({
      kind: 'ok',
      title: res.recovered ? `✔ ${res.move.san} — верно, продолжаем` : `✔ ${res.move.san}`,
      text: settings.comments ? res.move.comment : '',
      stats: settings.comments ? statsLine(res.move) : '',
      alternatives: settings.comments ? res.alternatives : [],
    });
    if (trainer.state.status === 'success') onSuccess();
    else scheduleOpponent();
  } else {
    streak = 0;
    if (!failRecorded) {
      failRecorded = true; // ошибка по линии засчитывается один раз за попытку
      bumpProgress(trainer.currentLines().map((l) => l.id), false);
    }
    // доска остаётся активной: нужно сделать правильный ход, чтобы продолжить
    board.setPosition(keyToFen(trainer.state.key), { lastMove: [from, to], canMove: true });
    board.setHighlights(new Map([[to, 'bad-move']]));
    board.setShapes(res.expected.map((m, i) => ({ orig: m.uci.slice(0, 2), dest: m.uci.slice(2, 4), brush: i === 0 ? 'green' : 'blue' })));
    renderStatus(trainer, opening, streak);
    renderMoves(trainer.state.history, trainer.state.wrong);
    const best = res.expected[0];
    renderFeedback({
      kind: 'bad',
      title: `✘ ${san} — не книжный ход. Правильно: ${res.expected.map((m) => m.san).join(' или ')}. Сделайте его, чтобы продолжить.`,
      text: best && settings.comments ? best.comment : '',
      stats: best && settings.comments ? statsLine(best) : '',
    });
  }
}

function onSuccess() {
  const { mistakes } = trainer.state;
  streak = mistakes || hintsUsed ? 0 : streak + 1;
  if (mistakes === 0 && hintsUsed === 0) bumpProgress(trainer.currentLines().map((l) => l.id), true);
  board.lock();
  renderStatus(trainer, opening, streak);
  const reason = trainer.state.reason === 'depth' ? `Вы сделали ${trainer.depth} книжных ходов.` : 'Книжная линия закончилась.';
  const title = mistakes ? `Линия пройдена с ошибками: ${mistakes}` : hintsUsed ? `Линия пройдена (подсказок: ${hintsUsed})` : '🎉 Линия пройдена без ошибок!';
  renderFeedback({ kind: mistakes ? 'info' : 'ok', title, text: `${reason} Нажмите «Ещё раз», чтобы закрепить.` });
}

function showHint() {
  if (!trainer || !trainer.isUserTurn()) return;
  const moves = trainer.bookMoves();
  if (!moves.length) return;
  hintsUsed += 1;
  board.setShapes(moves.map((m, i) => ({ orig: m.uci.slice(0, 2), dest: m.uci.slice(2, 4), brush: i === 0 ? 'green' : 'blue' })));
  renderFeedback({
    kind: 'info',
    title: `💡 Книжные ходы: ${moves.map((m) => m.san).join(', ')}`,
    text: settings.comments ? moves[0].comment : '',
    stats: settings.comments ? statsLine(moves[0]) : '',
  });
}

function toggleLineDump() {
  const list = $('moves-list');
  if (list.classList.contains('dump')) {
    list.classList.remove('dump');
    list.className = 'moves';
    renderMoves(trainer.state.history, trainer.state.wrong);
    $('btn-show-line').textContent = 'Показать линию';
  } else {
    list.className = 'dump';
    renderLineDump(trainer.state.history, list);
    $('btn-show-line').textContent = 'Скрыть линию';
  }
}

// ---------- инициализация ----------
async function init() {
  board = createBoard($('board'), { onUserMove });
  try {
    index = await loadIndex();
  } catch (e) {
    $('setup-error').hidden = false;
    $('setup-error').textContent = e.message;
    return;
  }
  fillForm();
  await refreshPreview();

  for (const id of ['opening-select', 'depth', 'lines-count', 'opt-comments', 'opt-dests']) $(id).addEventListener('input', refreshPreview);
  document.querySelectorAll('input[name=side]').forEach((r) => r.addEventListener('change', refreshPreview));
  $('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    readForm();
    try {
      startTraining();
    } catch (err) {
      $('setup-error').hidden = false;
      $('setup-error').textContent = err.message;
    }
  });
  $('btn-retry').addEventListener('click', startTraining);
  $('btn-show-line').addEventListener('click', toggleLineDump);
  $('btn-hint').addEventListener('click', showHint);
  $('btn-setup').addEventListener('click', () => showScreen('setup'));
  $('home-link').addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('setup');
  });
}

init();
