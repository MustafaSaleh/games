import { describe, expect, it } from 'vitest';
import type { HostTransport, Link, NetDriver } from '@engine/net/transport';
import { Room } from '../src/net/room';
import { decodeEnemies, decodePose, decodeShots, encodeEnemy, encodePose, encodeShot } from '../src/net/sync';
import { Mech } from '../src/units/mech';
import { Walker } from '../src/enemies/walker';

/** in-memory star network (async delivery like the real thing) */
function memoryNet(): NetDriver {
  const hosts = new Map<string, HostTransport & { onConnection: (l: Link) => void }>();
  let n = 0;
  const mk = (id: string): Link & { peer?: Link; open: boolean } => {
    const l = {
      id,
      open: true,
      peer: undefined as (Link & { open: boolean }) | undefined,
      onData: (_d: unknown) => {},
      onClose: () => {},
      send(d: unknown) {
        const p = l.peer;
        if (l.open && p?.open) queueMicrotask(() => p.onData(JSON.parse(JSON.stringify(d))));
      },
      close() {
        if (!l.open) return;
        l.open = false;
        const p = l.peer;
        if (p?.open) {
          p.open = false;
          queueMicrotask(() => p.onClose());
        }
      },
    };
    return l;
  };
  return {
    async host(code) {
      const t = { onConnection: (_l: Link) => {}, onError: () => {}, onOnline: () => {}, close: () => hosts.delete(code) };
      hosts.set(code, t);
      return t;
    },
    async join(code) {
      const h = hosts.get(code);
      if (!h) throw new Error('not-found');
      const id = 'g' + ++n;
      const guestSide = mk('host'),
        hostSide = mk(id);
      guestSide.peer = hostSide;
      hostSide.peer = guestSide;
      h.onConnection(hostSide);
      return guestSide;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('online room', () => {
  it('joins, shares the lobby, starts and relays game messages', async () => {
    const net = memoryNet();
    const host = await Room.create(net, 'Mody', 'tank', 'sunset', 'desert-bowl');
    const a = await Room.join(net, host.code, 'Sara', 'mech', 'ocean');
    const b = await Room.join(net, host.code, 'Omar', 'tank', 'jungle');
    await tick();
    expect(host.players.map((p) => p.name)).toEqual(['Mody', 'Sara', 'Omar']);
    expect(a.players.length).toBe(3);
    expect(new Set(host.players.map((p) => p.side)).size).toBe(2); // teams get balanced

    host.setMode('alliance');
    a.setLoadout('tank', 'galaxy');
    b.setSide('blue');
    await tick();
    expect(b.mode).toBe('alliance');
    expect(b.players.find((p) => p.name === 'Sara')?.livery).toBe('galaxy');
    expect(host.players.find((p) => p.name === 'Omar')?.side).toBe('blue');

    const started: string[] = [];
    a.ev.start = (mode) => started.push(mode);
    b.ev.start = (mode) => started.push(mode);
    host.start();
    await tick();
    expect(started).toEqual(['alliance', 'alliance']);

    // guest -> everyone, tagged with the sender
    const got: [string, string, unknown][] = [];
    host.ev.game = (t, id, d) => got.push(['host', t + ':' + id, d]);
    b.ev.game = (t, id, d) => got.push(['b', t + ':' + id, d]);
    a.send('pose', [1, 2, 3]);
    await tick();
    expect(got).toContainEqual(['host', 'pose:' + a.myId, [1, 2, 3]]);
    expect(got).toContainEqual(['b', 'pose:' + a.myId, [1, 2, 3]]);

    // a guest can't pretend to be the host (enemy snapshots, game over…)
    got.length = 0;
    a.send('enemies', []);
    a.send('over', { title: 'hacked' });
    host.send('wave', { n: 3 });
    await tick();
    expect(got.filter((g) => g[1].startsWith('enemies') || g[1].startsWith('over'))).toEqual([]);
    expect(got).toContainEqual(['b', 'wave:host', { n: 3 }]);

    // leaving
    const left: string[] = [];
    host.ev.left = (id) => left.push(id);
    b.leave();
    await tick();
    expect(left).toEqual([b.myId]);
    expect(host.players.length).toBe(2);
  });

  it('refuses a 5th player and joins during a battle', async () => {
    const net = memoryNet();
    const host = await Room.create(net, 'H', 'tank', 'sunset', 'x');
    for (let i = 0; i < 3; i++) await Room.join(net, host.code, 'P' + i, 'tank', 'sunset');
    await expect(Room.join(net, host.code, 'Late', 'tank', 'sunset')).rejects.toThrow('full');
    const host2 = await Room.create(net, 'H', 'tank', 'sunset', 'x');
    host2.start();
    await expect(Room.join(net, host2.code, 'Late', 'tank', 'sunset')).rejects.toThrow('playing');
  });
});

describe('wire format', () => {
  it('round-trips poses, shots and enemies', () => {
    const m = new Mech();
    m.x = 12.345;
    m.z = -7.5;
    m.airborne = true;
    m.jets = true;
    const p = decodePose(encodePose(m, true))!;
    expect(p.x).toBeCloseTo(12.35, 2);
    expect(p.airborne && p.jets && p.shield).toBe(true);
    expect(p.dashing).toBe(false);
    expect(decodePose([1, 2, 'x'])).toBeNull();

    const s = decodeShots([...encodeShot('bolt', { x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6 }), ...encodeShot('plasma', { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })]);
    expect(s.map((x) => x.kind)).toEqual(['bolt', 'plasma']);

    const w = new Walker('walker42', 1);
    w.x = 3;
    w.hp = 33;
    const [row] = decodeEnemies([encodeEnemy(w)]);
    expect(row).toMatchObject({ id: 'walker42', kind: 'walker', x: 3, hp: 33 });
  });
});
