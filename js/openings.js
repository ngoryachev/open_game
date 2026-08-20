const BASE = new URL('../data/openings/', import.meta.url);

export async function loadIndex() {
  const res = await fetch(new URL('index.json', BASE));
  if (!res.ok) throw new Error(`Не удалось загрузить список дебютов: ${res.status}`);
  return res.json();
}

const cache = new Map();
export async function loadOpening(entry) {
  if (cache.has(entry.id)) return cache.get(entry.id);
  const res = await fetch(new URL(entry.file, BASE));
  if (!res.ok) throw new Error(`Не удалось загрузить дебют ${entry.id}: ${res.status}`);
  const data = await res.json();
  cache.set(entry.id, data);
  return data;
}
