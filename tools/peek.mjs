#!/usr/bin/env node
// Показать топ-ходы базы мастеров для позиции: node tools/peek.mjs "1.e4 c5 2.c3 Nf6 3.e5 Nd5 4.Nf3"
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Chess } from '../vendor/chess.js';
import { fenKey } from '../js/fen.js';
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) for (const l of readFileSync(envFile, 'utf8').split('\n')) { const m = l.match(/^(\w+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function lookup(key) {
  const file = new URL(`../tools/cache/${createHash('sha1').update(key + ' 0 1').digest('hex').slice(0, 16)}.json`, import.meta.url);
  let d;
  if (existsSync(file)) d = JSON.parse(readFileSync(file, 'utf8'));
  else {
    let res;
    for (;;) {
      res = await fetch(`https://explorer.lichess.org/masters?fen=${encodeURIComponent(key + ' 0 1')}&moves=20&topGames=0`, { headers: { Authorization: `Bearer ${process.env.LICHESS_TOKEN}` } });
      if (res.status !== 429) break;
      process.stderr.write('429, wait 60s\n'); await sleep(60000);
    }
    const raw = await res.json();
    d = { white: raw.white, draws: raw.draws, black: raw.black, opening: raw.opening, moves: raw.moves.map((m) => ({ uci: m.uci, san: m.san, white: m.white, draws: m.draws, black: m.black, averageRating: m.averageRating })) };
    writeFileSync(file, JSON.stringify(d));
    await sleep(500);
  }
  return d;
}

// Аргумент: "1.e4 c5 ..." — показать топ-ходы; "1.e4 c5 ...|6" — дополнительно достроить главную линию на 6 полуходов.
for (const arg of process.argv.slice(2)) {
  const [pathStr, autoStr] = arg.split('|');
  const chess = new Chess();
  for (const t of pathStr.trim().split(/\s+/)) { const san = t.replace(/^\d+\.+/, ''); if (san) chess.move(san); }
  const d = await lookup(fenKey(chess.fen()));
  const total = d.moves.reduce((a, m) => a + m.white + m.draws + m.black, 0) || 1;
  console.log(`\n${pathStr.trim()}  (${d.opening?.name ?? ''})`);
  for (const m of d.moves.slice(0, 8)) { const g = m.white + m.draws + m.black; console.log(`  ${m.san.padEnd(6)} ${String(Math.round(100 * g / total)).padStart(3)}%  ${String(g).padStart(6)}  W${Math.round(100 * m.white / g)}/D${Math.round(100 * m.draws / g)}/B${Math.round(100 * m.black / g)}`); }
  if (autoStr) {
    const line = [];
    for (let i = 0; i < +autoStr; i++) {
      const dd = await lookup(fenKey(chess.fen()));
      const t = dd.moves.reduce((a, m) => a + m.white + m.draws + m.black, 0) || 1;
      const top = dd.moves[0];
      if (!top) break;
      const g = top.white + top.draws + top.black;
      const n = chess.moveNumber();
      line.push(`${chess.turn() === 'w' ? n + '.' : ''}${top.san}(${Math.round(100 * g / t)}%,${g})`);
      chess.move(top.san);
    }
    console.log('  → главная линия: ' + line.join(' '));
  }
}
