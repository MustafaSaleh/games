import { describe, expect, it } from 'vitest';
import { localDriver } from '../src/net/transport';
import { MAX_PLAYERS, Session, cleanName, normCode } from '../src/net/session';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('online session (local transport)', () => {
  it('normalises codes and names', () => {
    expect(normCode('tiger 42')).toBe('TIGER-42');
    expect(normCode('Tiger-42')).toBe('TIGER-42');
    expect(cleanName('  <b>Mody</b> the very fast  ')).toBe('bMody/b the');
    expect(cleanName('   ')).toBe('Racer');
  });

  it('host + guests: lobby, start, poses, finish, leave', async () => {
    const d = localDriver();
    const host = await Session.create(d, 'Mody', 'hatch', 'white', 'forest-ridge');
    const got: string[] = [];
    host.ev.pose = (id, p) => got.push(`h:pose:${id}:${p[1]}`);
    host.ev.finish = (id, t) => got.push(`h:finish:${id}:${t}`);
    const g1 = await Session.join(d, host.code, 'Sara', 'coupe', 'red');
    const g2 = await Session.join(d, host.code, 'Omar', 'truck', 'blue');
    await tick();
    expect(host.players.map((p) => p.name)).toEqual(['Mody', 'Sara', 'Omar']);
    expect(g2.players.map((p) => p.slot)).toEqual([0, 1, 2]);
    expect(g1.me?.name).toBe('Sara');

    host.setStage('dune-run');
    await tick();
    expect(g1.stageId).toBe('dune-run');

    const starts: string[] = [];
    g1.ev.start = (s) => starts.push('g1:' + s);
    g2.ev.start = (s) => starts.push('g2:' + s);
    host.start();
    await tick();
    expect(starts.sort()).toEqual(['g1:dune-run', 'g2:dune-run']);

    const g2poses: string[] = [];
    g2.ev.pose = (id, p) => g2poses.push(`${id === g1.myId ? 'g1' : id}:${p[1]}`);
    g1.sendPose([1, 5, 0, 0, 0, 0, 0, 10, 20]);
    host.sendPose([1, 7, 0, 0, 0, 0, 0, 12, 20]);
    g1.sendFinish(61.5);
    await tick();
    expect(g2poses.sort()).toEqual(['g1:5', 'host:7']);
    expect(got).toContain(`h:finish:${g1.myId}:61.5`);

    let left = '';
    host.ev.left = (id) => (left = id);
    const g1id = g1.myId;
    g1.leave();
    await tick();
    expect(left).toBe(g1id);
    expect(host.players.length).toBe(2);

    let closed = '';
    g2.ev.closed = (r) => (closed = r);
    host.leave();
    await tick();
    expect(closed).toMatch(/host left/i);
  });

  it('rejects when full and when the room does not exist', async () => {
    const d = localDriver();
    const host = await Session.create(d, 'A', 'hatch', 'white', 's');
    const guests = [];
    for (let i = 1; i < MAX_PLAYERS; i++) guests.push(await Session.join(d, host.code, 'G' + i, 'hatch', 'white'));
    await expect(Session.join(d, host.code, 'Late', 'hatch', 'white')).rejects.toThrow('full');
    await expect(Session.join(d, 'NOPE-99', 'X', 'hatch', 'white')).rejects.toThrow('not-found');
    for (const g of guests) g.leave();
    host.leave();
  });
});
