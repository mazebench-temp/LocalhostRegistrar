export function normalizeOrder(value) {
  return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string'))] : [];
}

export function orderApps(apps, savedOrder) {
  const positions = new Map(normalizeOrder(savedOrder).map((id, index) => [id, index]));
  return [...apps].sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
}

export function moveApp(order, id, targetId) {
  const result = normalizeOrder(order);
  const from = result.indexOf(id);
  const to = result.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return result;
  result.splice(from, 1);
  result.splice(to, 0, id);
  return result;
}
