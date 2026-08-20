// Обёртка над chessground + chess.js: доска показывает только легальные ходы.
import { Chessground } from '../vendor/chessground/chessground.min.js';
import { Chess, SQUARES } from '../vendor/chess.js';

function legalDests(chess) {
  const dests = new Map();
  for (const sq of SQUARES) {
    const moves = chess.moves({ square: sq, verbose: true });
    if (moves.length) dests.set(sq, moves.map((m) => m.to));
  }
  return dests;
}

/**
 * @param {HTMLElement} el
 * @param {{onUserMove: (uci: string, san: string) => void}} handlers
 */
export function createBoard(el, { onUserMove }) {
  const chess = new Chess();
  let movable = false;
  let showDests = true;

  const cg = Chessground(el, {
    coordinates: true,
    animation: { enabled: true, duration: 200 },
    movable: { free: false, color: undefined, showDests: true, events: { after: onMove } },
    draggable: { showGhost: true },
    highlight: { lastMove: true, check: true },
    drawable: { enabled: false, visible: true },
  });

  function onMove(orig, dest) {
    // Определяем превращение (упрощение: всегда в ферзя).
    const cand = chess.moves({ square: orig, verbose: true }).find((m) => m.to === dest);
    if (!cand) return;
    const promotion = cand.promotion ? 'q' : undefined;
    const mv = chess.move({ from: orig, to: dest, promotion });
    const uci = orig + dest + (promotion || '');
    onUserMove(uci, mv.san);
  }

  function sync(lastMove) {
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    cg.set({
      fen: chess.fen(),
      turnColor: turn,
      check: chess.inCheck(),
      lastMove,
      movable: {
        color: movable ? turn : undefined,
        dests: movable ? legalDests(chess) : new Map(),
        showDests,
      },
    });
  }

  return {
    /** Установить позицию (FEN), разрешить/запретить ходы пользователя. */
    setPosition(fen, { lastMove, canMove = false } = {}) {
      chess.load(fen);
      movable = canMove;
      sync(lastMove);
    },
    setOrientation(color) {
      cg.set({ orientation: color });
    },
    setShowDests(v) {
      showDests = v;
      sync(cg.state.lastMove);
    },
    /** Стрелки: [{orig, dest, brush}] */
    setShapes(shapes) {
      cg.setShapes(shapes);
    },
    /** Подсветка клеток: Map<square, className> */
    setHighlights(map) {
      cg.set({ highlight: { custom: map } });
    },
    lock() {
      movable = false;
      sync(cg.state.lastMove);
    },
    fen: () => chess.fen(),
  };
}
