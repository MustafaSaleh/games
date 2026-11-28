import { cleanName, makeCode } from '@engine/net/session';
import type { HostTransport, Link, NetDriver } from '@engine/net/transport';
import { unitKind, type UnitKind } from '../units/unit';

/**
 * Online rooms for Dust Titans (same star topology as Dust Rally: guests talk only to the
 * host). The room handles joining, the lobby (unit, colour, team, mode) and relays game
 * messages. Authority:
 *  - every device drives its own unit and decides when IT is hit (victim decides, like the
 *    tomato fight), then reports knock-outs;
 *  - the host runs the enemies, waves and crates and sends snapshots.
 */
export const MAX_PLAYERS = 4;
export const HOST_ID = 'host';
export const PROTOCOL = 1;
export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
export const EMOTES = ['👍', '👋', '😂', '😮', '🔥', '🛡️', '🤖', '😎'] as const;

export type Mode = 'coop' | 'arena' | 'alliance';
export type Side = 'blue' | 'red';

export const MODES: Record<Mode, { name: string; blurb: string; min: number }> = {
  coop: { name: 'Defend together', blurb: 'Team up against the waves and the Giant Robot', min: 1 },
  arena: { name: 'Arena battle', blurb: 'Everyone for themselves · most knock-outs wins', min: 2 },
  alliance: { name: 'Alliance battle', blurb: 'Blue vs Red, with enemy waves in between', min: 2 },
};

export interface RoomPlayer {
  id: string;
  name: string;
  unit: UnitKind;
  livery: string;
  slot: number;
  side: Side;
}

/** messages a guest may only receive from the host */
const HOST_ONLY = new Set(['enemies', 'eshot', 'wave', 'drop', 'over', 'score', 'clock']);

type Msg =
  | { k: 'hello'; v: number; build?: string; name: string; unit: UnitKind; livery: string }
  | { k: 'welcome'; id: string }
  | { k: 'reject'; reason: string }
  | { k: 'lobby'; players: RoomPlayer[]; mode: Mode; arena: string; playing: boolean }
  | { k: 'start'; mode: Mode; arena: string; players: RoomPlayer[]; seed: number }
  | { k: 'loadout'; unit: UnitKind; livery: string }
  | { k: 'side'; side: Side }
  | { k: 'g'; t: string; id?: string; d: unknown };

export interface RoomEvents {
  lobby(): void;
  start(mode: Mode, arena: string, players: RoomPlayer[], seed: number): void;
  /** a game message of type `t` from player `id` */
  game(t: string, id: string, d: unknown): void;
  left(id: string): void;
  closed(reason: string): void;
}

export class Room {
  players: RoomPlayer[] = [];
  mode: Mode = 'coop';
  arena = '';
  playing = false;
  myId = HOST_ID;
  serverOnline = true;
  ev: RoomEvents = { lobby() {}, start() {}, game() {}, left() {}, closed() {} };
  private links = new Map<string, Link>();
  private hostLink: Link | null = null;
  private hostT: HostTransport | null = null;
  private dead = false;
  private lastEmote = new Map<string, number>();

  private constructor(
    readonly code: string,
    readonly isHost: boolean,
  ) {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => this.leave());
  }

  get me(): RoomPlayer | undefined {
    return this.players.find((p) => p.id === this.myId);
  }

  static async create(driver: NetDriver, name: string, unit: UnitKind, livery: string, arena: string): Promise<Room> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode();
      try {
        const t = await driver.host(code);
        const r = new Room(code, true);
        r.hostT = t;
        r.arena = arena;
        r.players = [{ id: HOST_ID, name: cleanName(name), unit, livery, slot: 0, side: 'blue' }];
        t.onConnection = (link) => r.onGuest(link);
        t.onError = (msg) => r.close(msg);
        t.onOnline = (on) => {
          r.serverOnline = on;
          r.ev.lobby();
        };
        return r;
      } catch (e) {
        lastErr = e as Error;
        if (lastErr.message !== 'taken') break;
      }
    }
    throw lastErr ?? new Error('failed');
  }

  static async join(driver: NetDriver, code: string, name: string, unit: UnitKind, livery: string): Promise<Room> {
    const link = await driver.join(code);
    const r = new Room(code, false);
    r.hostLink = link;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        link.close();
        reject(new Error('timeout'));
      }, 8000);
      link.onData = (d) => {
        const m = d as Msg;
        if (!m || typeof m !== 'object') return;
        if (m.k === 'welcome') r.myId = m.id;
        else if (m.k === 'reject') {
          clearTimeout(timer);
          link.close();
          reject(new Error(m.reason));
        } else if (m.k === 'lobby' && r.myId !== HOST_ID) {
          clearTimeout(timer);
          r.applyLobby(m);
          link.onData = (d2) => {
            if (d2 && typeof d2 === 'object') r.onHostMsg(d2 as Msg);
          };
          resolve(r);
        }
      };
      link.onClose = () => {
        clearTimeout(timer);
        reject(new Error('closed'));
        r.close('The host left the room');
      };
      link.send({ k: 'hello', v: PROTOCOL, build: BUILD, name: cleanName(name), unit, livery } satisfies Msg);
    });
  }

  /* -------------------------------- host --------------------------------- */

  private onGuest(link: Link): void {
    let joined = false;
    link.onData = (d) => {
      const m = d as Msg;
      if (!m || typeof m !== 'object') return;
      if (!joined) {
        if (m.k !== 'hello') return;
        if (m.v !== PROTOCOL || (m.build !== BUILD && BUILD !== 'dev' && m.build !== 'dev')) return this.reject(link, 'version');
        if (this.players.length >= MAX_PLAYERS) return this.reject(link, 'full');
        if (this.playing) return this.reject(link, 'playing');
        joined = true;
        this.links.set(link.id, link);
        const used = new Set(this.players.map((p) => p.slot));
        let slot = 0;
        while (used.has(slot)) slot++;
        const blues = this.players.filter((p) => p.side === 'blue').length;
        this.players.push({ id: link.id, name: cleanName(m.name), unit: unitKind(m.unit), livery: String(m.livery), slot, side: blues > this.players.length - blues ? 'red' : 'blue' });
        link.send({ k: 'welcome', id: link.id } satisfies Msg);
        this.broadcastLobby();
        return;
      }
      if (m.k === 'loadout') {
        const p = this.players.find((x) => x.id === link.id);
        if (p) {
          p.unit = unitKind(m.unit);
          p.livery = String(m.livery);
          this.broadcastLobby();
        }
      } else if (m.k === 'side') {
        const p = this.players.find((x) => x.id === link.id);
        if (p && (m.side === 'blue' || m.side === 'red')) {
          p.side = m.side;
          this.broadcastLobby();
        }
      } else if (m.k === 'g' && typeof m.t === 'string' && !HOST_ONLY.has(m.t)) {
        if (m.t === 'emote' && !this.allowEmote(link.id)) return;
        this.relay({ k: 'g', t: m.t, id: link.id, d: m.d }, link.id);
        this.ev.game(m.t, link.id, m.d);
      }
    };
    link.onClose = () => {
      if (!this.links.delete(link.id)) return;
      this.players = this.players.filter((p) => p.id !== link.id);
      this.ev.left(link.id);
      this.broadcastLobby();
    };
  }

  private allowEmote(id: string): boolean {
    const now = Date.now();
    if (now - (this.lastEmote.get(id) ?? 0) < 700) return false;
    this.lastEmote.set(id, now);
    return true;
  }

  private reject(link: Link, reason: string): void {
    link.send({ k: 'reject', reason } satisfies Msg);
    setTimeout(() => link.close(), 300);
  }

  private relay(m: Msg, except?: string): void {
    for (const [id, l] of this.links) if (id !== except) l.send(m);
  }

  private broadcastLobby(): void {
    this.relay({ k: 'lobby', players: this.players, mode: this.mode, arena: this.arena, playing: this.playing });
    this.ev.lobby();
  }

  setMode(mode: Mode): void {
    if (!this.isHost) return;
    this.mode = mode;
    this.broadcastLobby();
  }

  setArena(id: string): void {
    if (!this.isHost) return;
    this.arena = id;
    this.broadcastLobby();
  }

  /** host: everybody goes */
  start(): void {
    if (!this.isHost) return;
    this.playing = true;
    const seed = Math.floor(Math.random() * 1e9);
    this.relay({ k: 'start', mode: this.mode, arena: this.arena, players: this.players, seed });
    this.broadcastLobby();
    this.ev.start(this.mode, this.arena, this.players, seed);
  }

  /** host: back to the lobby */
  endGame(): void {
    if (!this.isHost) return;
    this.playing = false;
    this.broadcastLobby();
  }

  /* -------------------------------- guest -------------------------------- */

  private applyLobby(m: { players: RoomPlayer[]; mode: Mode; arena: string; playing: boolean }): void {
    this.players = Array.isArray(m.players) ? m.players : [];
    this.mode = m.mode;
    this.arena = m.arena;
    this.playing = !!m.playing;
  }

  private onHostMsg(m: Msg): void {
    if (m.k === 'lobby') {
      const before = new Set(this.players.map((p) => p.id));
      this.applyLobby(m);
      for (const id of before) if (!this.players.some((p) => p.id === id)) this.ev.left(id);
      this.ev.lobby();
    } else if (m.k === 'start') {
      this.players = m.players;
      this.mode = m.mode;
      this.arena = m.arena;
      this.playing = true;
      this.ev.start(m.mode, m.arena, m.players, m.seed);
    } else if (m.k === 'g' && typeof m.t === 'string') {
      const id = m.id ?? HOST_ID;
      if (HOST_ONLY.has(m.t) && id !== HOST_ID) return;
      this.ev.game(m.t, id, m.d);
    }
  }

  /* ------------------------------- both ---------------------------------- */

  /** send a game message to everyone else */
  send(t: string, d: unknown): void {
    if (this.dead) return;
    if (this.isHost) {
      if (t === 'emote' && !this.allowEmote(HOST_ID)) return;
      this.relay({ k: 'g', t, id: HOST_ID, d });
    } else this.hostLink?.send({ k: 'g', t, d } satisfies Msg);
  }

  setLoadout(unit: UnitKind, livery: string): void {
    const me = this.me;
    if (me) {
      me.unit = unit;
      me.livery = livery;
    }
    if (this.isHost) this.broadcastLobby();
    else this.hostLink?.send({ k: 'loadout', unit, livery } satisfies Msg);
  }

  setSide(side: Side): void {
    const me = this.me;
    if (me) me.side = side;
    if (this.isHost) this.broadcastLobby();
    else this.hostLink?.send({ k: 'side', side } satisfies Msg);
  }

  private close(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.ev.closed(reason);
  }

  leave(): void {
    if (this.dead) return;
    this.dead = true;
    for (const l of this.links.values()) l.close();
    this.links.clear();
    this.hostLink?.close();
    this.hostT?.close();
  }
}
