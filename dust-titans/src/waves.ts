import type { EnemyKind } from './enemies/enemy';

/** Which enemies a wave sends. Every 5th wave is a Giant Robot boss wave. */
export function waveSpawns(n: number): EnemyKind[] {
  const rep = (k: EnemyKind, c: number) => Array<EnemyKind>(Math.max(0, c)).fill(k);
  const early: Record<number, EnemyKind[]> = {
    1: rep('drone', 3),
    2: rep('drone', 4),
    3: [...rep('drone', 2), ...rep('walker', 2)],
    4: [...rep('drone', 2), 'walker', ...rep('alien', 3)],
  };
  if (early[n]) return early[n];
  if (n % 5 === 0) return ['boss', ...rep('drone', Math.min(1 + n / 5, 5))];
  const d = 2 + Math.floor(n / 3),
    w = 1 + Math.floor(n / 4),
    a = Math.floor(n / 3);
  // interleave so the kinds arrive mixed
  const lists = [rep('drone', d), rep('walker', w), rep('alien', a)];
  const out: EnemyKind[] = [];
  while (out.length < 12 && lists.some((l) => l.length)) for (const l of lists) if (l.length && out.length < 12) out.push(l.pop()!);
  return out;
}

/** boss level for a boss wave (1 on wave 5, 2 on wave 10, ...) */
export const bossLevel = (n: number): number => Math.max(1, Math.floor(n / 5));
