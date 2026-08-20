// Утилиты для ключей позиций. Ключ = FEN без счётчиков полуходов/ходов,
// чтобы одинаковые позиции (транспозиции) попадали в один узел графа.
export function fenKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function keyToFen(key) {
  return key.split(' ').length >= 6 ? key : `${key} 0 1`;
}

export function sideToMove(key) {
  return key.split(' ')[1] === 'w' ? 'white' : 'black';
}
