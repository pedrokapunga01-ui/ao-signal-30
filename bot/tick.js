function normalizeOutcome(value) {
  if (value && typeof value === 'object') {
    value = value.outcome ?? value.resultado ?? value.winner ?? value.name;
  }
  const s = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

  // Jogador
  if (['player', 'jogador', 'playerwin', 'playerwins', 'playerwon', 'playerwinner'].includes(s)) {
    return 'Jogador';
  }

  // Banca
  if (['banker', 'banca', 'bankerwin', 'bankerwins', 'bankerwon', 'bankerwinner', 'red', 'vermelho'].includes(s)) {
    return 'Banca';
  }

  // Empate
  if (['tie', 'draw', 'empate', 'equal', 'push', 'tied'].includes(s)) {
    return 'Empate';
  }

  return null;
}