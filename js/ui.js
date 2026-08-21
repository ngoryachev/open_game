// Рендер панелей тренировки. Только DOM, без логики.
const $ = (id) => document.getElementById(id);

export function renderLinesPreview(lines) {
  const ol = $('lines-preview');
  ol.innerHTML = '';
  for (const l of lines) {
    const li = document.createElement('li');
    li.textContent = l.name;
    if (l.always) li.classList.add('muted');
    if (l.eco) {
      const eco = document.createElement('span');
      eco.className = 'eco';
      eco.textContent = l.eco;
      li.append(eco);
    }
    ol.append(li);
  }
  if (!lines.length) ol.innerHTML = '<li class="muted">Нет линий за эту сторону</li>';
}

export function renderStatus(trainer, opening, streak) {
  const st = trainer.state;
  $('train-opening').textContent = opening.name;
  const all = trainer.currentLines();
  const mainAll = trainer.lines.filter((l) => !l.always);
  let cur = all.filter((l) => !l.always);
  if (!cur.length) cur = all;
  $('train-line').textContent =
    cur.length === 1 ? cur[0].name : cur.length === mainAll.length ? 'Линия определится по ходам' : cur.map((l) => l.name).join(' / ');
  const badge = $('train-status');
  badge.className = `status-badge ${st.status}`;
  badge.textContent = { playing: trainer.isUserTurn() ? 'Ваш ход' : 'Ход соперника', success: 'Линия пройдена', fail: 'Ошибка — сделайте правильный ход' }[st.status];
  $('progress-bar').style.width = `${Math.min(100, (st.userMoves / trainer.depth) * 100)}%`;
  $('progress-text').textContent = `${st.userMoves} / ${trainer.depth} ходов · ошибок: ${st.mistakes}`;
  $('streak').textContent = streak;
}

export function renderMoves(history, wrong) {
  const ol = $('moves-list');
  ol.innerHTML = '';
  const all = wrong ? [...history, { san: wrong.san, by: 'user', bad: true }] : history;
  for (let i = 0; i < all.length; i += 2) {
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `${i / 2 + 1}.`;
    ol.append(num);
    for (const h of [all[i], all[i + 1]]) {
      const span = document.createElement('span');
      span.className = 'mv';
      if (h) {
        span.textContent = h.san;
        if (h.by === 'user') span.classList.add('user');
        if (h.bad) span.classList.add('bad');
        if (h === all[all.length - 1]) span.classList.add('last');
      }
      ol.append(span);
    }
  }
  ol.scrollTop = ol.scrollHeight;
}

/** Короткая строка статистики хода из базы мастеров. */
export function statsLine(move) {
  const st = move?.stats;
  if (!st || !st.games) return '';
  const pct = (x) => Math.round(x * 100);
  return `База мастеров: ${pct(st.share)} % партий (${st.games}), результат ${pct(st.white)}/${pct(st.draws)}/${pct(st.black)}.`;
}

export function renderFeedback({ kind, title, text, stats, alternatives = [] } = {}) {
  const box = $('feedback');
  if (!kind) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.className = `card feedback ${kind}`;
  box.innerHTML = '';
  const h = document.createElement('h4');
  h.textContent = title;
  box.append(h);
  if (text) {
    const p = document.createElement('p');
    p.textContent = text;
    box.append(p);
  }
  if (stats) {
    const p = document.createElement('p');
    p.className = 'alt';
    p.textContent = stats;
    box.append(p);
  }
  if (alternatives.length) {
    const p = document.createElement('p');
    p.className = 'alt';
    p.textContent = `Также возможно: ${alternatives.map((m) => m.san).join(', ')}`;
    box.append(p);
  }
}

export function renderLineDump(history, container) {
  container.innerHTML = '';
  const ol = document.createElement('ol');
  ol.className = 'line-dump';
  history.forEach((h, i) => {
    const li = document.createElement('li');
    const n = Math.floor(i / 2) + 1;
    const prefix = i % 2 === 0 ? `${n}. ` : `${n}… `;
    const b = document.createElement('b');
    b.textContent = prefix + h.san;
    const c = document.createElement('span');
    c.className = 'c';
    c.textContent = h.comment ? ` — ${h.comment}` : '';
    li.append(b, c);
    ol.append(li);
  });
  container.append(ol);
}
