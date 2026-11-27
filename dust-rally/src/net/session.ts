import type { HostTransport, Link, NetDriver } from './transport';

/**
 * An online room. The host is authoritative for the lobby (players, stage, start);
 * guests only talk to the host, which relays poses/finishes to everyone else.
 * Kid-safe by design: private rooms by code only, no chat, short names.
 */

export const MAX_PLAYERS = 4;
const PROTOCOL = 1;
export const HOST_ID = 'host';
/** this build's id: a friend on a different build is turned away with a clear message */
export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

export interface MpPlayer {
  id: string;
  name: string;
  style: string;
  livery: string;
  slot: number;
}

/** pose sample: [raceTime, x, y, z, heading, upX, upZ, progressS, speed, braking 0/1] */
export type PoseArr = number[];

type Msg =
  | { k: 'hello'; v: number; build?: string; name: string; style: string; livery: string }
  | { k: 'welcome'; id: string }
  | { k: 'reject'; reason: string }
  | { k: 'lobby'; players: MpPlayer[]; stageId: string; racing: boolean }
  | { k: 'start'; stageId: string; players: MpPlayer[] }
  | { k: 'pose'; id?: string; p: PoseArr }
  | { k: 'finish'; id?: string; time: number }
  | { k: 'car'; style: string; livery: string }
  | { k: 'claim'; gate: number }
  | { k: 'award'; id: string; gate: number }
  | { k: 'throw'; id?: string; p: number[] }
  | { k: 'splat'; id?: string; by: string };

const WORDS = ['TIGER', 'ROCKET', 'DUST', 'TURBO', 'CACTUS', 'COMET', 'EAGLE', 'FOX', 'LIZARD', 'STORM', 'DRIFT', 'GECKO', 'FALCON', 'BISON', 'MOJAVE', 'SPARK'];

export function makeCode(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)] + '-' + String(10 + Math.floor(Math.random() * 90));
}

/** Normalise what a kid types: "tiger 42" / "tiger42" -> "TIGER-42" */
export function normCode(s: string): string {
  const m = s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .match(/^([A-Z]+)(\d+)$/);
  return m ? `${m[1]}-${m[2]}` : s.toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

export function cleanName(s: string): string {
  return (
    s
      .replace(/[\u0000-\u001f<>]/g, '')
      .trim()
      .slice(0, 12)
      .trim() || 'Racer'
  );
}

export interface SessionEvents {
  lobby(): void;
  start(stageId: string, players: MpPlayer[]): void;
  pose(id: string, p: PoseArr): void;
  finish(id: string, time: number): void;
  left(id: string): void;
  closed(reason: string): void;
  /** tomato fight: `id` was first through checkpoint `gate` and earned a tomato */
  award(id: string, gate: number): void;
  /** `id` threw a tomato: [x, y, z, vx, vy, vz] */
  throw(id: string, p: number[]): void;
  /** `id` got hit by a tomato from `by` (the victim's device decides) */
  splat(id: string, by: string): void;
}

export class Session {
  players: MpPlayer[] = [];
  stageId = '';
  racing = false;
  myId = HOST_ID;
  /** host: registered with the room server (new friends can join) */
  serverOnline = true;
  private links = new Map<string, Link>(); // host: guests
  private hostLink: Link | null = null; // guest: host
  private hostT: HostTransport | null = null;
  private dead = false;
  ev: SessionEvents = { lobby() {}, start() {}, pose() {}, finish() {}, left() {}, closed() {}, award() {}, throw() {}, splat() {} };
  /** host: checkpoints already claimed this race (first come, first served) */
  private claimed = new Set<number>();

  private constructor(
    readonly code: string,
    readonly isHost: boolean,
  ) {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => this.leave());
  }

  get me(): MpPlayer | undefined {
    return this.players.find((p) => p.id === this.myId);
  }

  /* -------------------------- creating / joining -------------------------- */

  static async create(driver: NetDriver, name: string, style: string, livery: string, stageId: string): Promise<Session> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode();
      try {
        const t = await driver.host(code);
        const s = new Session(code, true);
        s.hostT = t;
        s.stageId = stageId;
        s.players = [{ id: HOST_ID, name: cleanName(name), style, livery, slot: 0 }];
        t.onConnection = (link) => s.onGuest(link);
        t.onError = (msg) => s.close(msg);
        t.onOnline = (on) => {
          s.serverOnline = on;
          s.ev.lobby();
        };
        return s;
      } catch (e) {
        lastErr = e as Error;
        if (lastErr.message !== 'taken') break;
      }
    }
    throw lastErr ?? new Error('failed');
  }

  static async join(driver: NetDriver, code: string, name: string, style: string, livery: string): Promise<Session> {
    const link = await driver.join(code);
    const s = new Session(code, false);
    s.hostLink = link;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        link.close();
        reject(new Error('timeout'));
      }, 8000);
      link.onData = (d) => {
        const m = d as Msg;
        if (!m || typeof m !== 'object') return; // ignore anything malformed
        if (m.k === 'welcome') {
          s.myId = m.id;
        } else if (m.k === 'reject') {
          clearTimeout(timer);
          link.close();
          reject(new Error(m.reason));
        } else if (m.k === 'lobby' && s.myId !== HOST_ID) {
          clearTimeout(timer);
          s.applyLobby(m);
          link.onData = (d2) => {
            if (d2 && typeof d2 === 'object') s.onHostMsg(d2 as Msg);
          };
          resolve(s);
        }
      };
      link.onClose = () => {
        clearTimeout(timer);
        reject(new Error('closed'));
        s.close('The host left the room');
      };
      link.send({ k: 'hello', v: PROTOCOL, build: BUILD, name: cleanName(name), style, livery } satisfies Msg);
    });
  }

  /* -------------------------------- host --------------------------------- */

  private onGuest(link: Link): void {
    let joined = false;
    link.onData = (d) => {
      const m = d as Msg;
        if (!m || typeof m !== 'object') return; // ignore anything malformed
      if (!joined) {
        if (m.k !== 'hello') return;
        if (m.v !== PROTOCOL || (m.build !== BUILD && BUILD !== 'dev' && m.build !== 'dev')) return this.reject(link, 'version');
        if (this.players.length >= MAX_PLAYERS) return this.reject(link, 'full');
        joined = true;
        this.links.set(link.id, link);
        const used = new Set(this.players.map((p) => p.slot));
        let slot = 0;
        while (used.has(slot)) slot++;
        this.players.push({ id: link.id, name: cleanName(m.name), style: String(m.style), livery: String(m.livery), slot });
        link.send({ k: 'welcome', id: link.id } satisfies Msg);
        this.broadcastLobby();
        return;
      }
      if (m.k === 'pose') {
        this.relay({ k: 'pose', id: link.id, p: m.p }, link.id);
        this.ev.pose(link.id, m.p);
      } else if (m.k === 'finish') {
        this.relay({ k: 'finish', id: link.id, time: m.time }, link.id);
        this.ev.finish(link.id, m.time);
      } else if (m.k === 'claim') {
        this.grant(link.id, Number(m.gate));
      } else if (m.k === 'throw') {
        this.relay({ k: 'throw', id: link.id, p: m.p }, link.id);
        this.ev.throw(link.id, m.p);
      } else if (m.k === 'splat') {
        this.relay({ k: 'splat', id: link.id, by: String(m.by) }, link.id);
        this.ev.splat(link.id, String(m.by));
      } else if (m.k === 'car') {
        const p = this.players.find((q) => q.id === link.id);
        if (p) {
          p.style = String(m.style);
          p.livery = String(m.livery);
          this.broadcastLobby();
        }
      }
    };
    link.onClose = () => {
      if (!this.links.delete(link.id)) return;
      this.players = this.players.filter((p) => p.id !== link.id);
      this.ev.left(link.id);
      this.broadcastLobby();
    };
  }

  private reject(link: Link, reason: string): void {
    link.send({ k: 'reject', reason } satisfies Msg);
    setTimeout(() => link.close(), 300);
  }

  private relay(m: Msg, except?: string): void {
    for (const [id, l] of this.links) if (id !== except) l.send(m);
  }

  private broadcastLobby(): void {
    this.relay({ k: 'lobby', players: this.players, stageId: this.stageId, racing: this.racing });
    this.ev.lobby();
  }

  setStage(id: string): void {
    if (!this.isHost) return;
    this.stageId = id;
    this.broadcastLobby();
  }

  /** host: everyone in the room starts the race now */
  start(stageId = this.stageId): void {
    if (!this.isHost) return;
    this.stageId = stageId;
    this.racing = true;
    this.claimed.clear();
    const m: Msg = { k: 'start', stageId, players: this.players };
    this.relay(m);
    this.ev.start(stageId, this.players.slice());
  }

  /** host: race over for everyone -> back to lobby state (latecomers can join the next race) */
  endRace(): void {
    if (!this.isHost || !this.racing) return;
    this.racing = false;
    this.broadcastLobby();
  }

  /* -------------------------------- guest -------------------------------- */

  private applyLobby(m: { players: MpPlayer[]; stageId: string; racing: boolean }): void {
    this.players = m.players;
    this.stageId = m.stageId;
    this.racing = m.racing;
  }

  private onHostMsg(m: Msg): void {
    if (m.k === 'lobby') {
      this.applyLobby(m);
      this.ev.lobby();
    } else if (m.k === 'start') {
      this.players = m.players;
      this.stageId = m.stageId;
      this.racing = true;
      this.ev.start(m.stageId, m.players);
    } else if (m.k === 'pose' && m.id) this.ev.pose(m.id, m.p);
    else if (m.k === 'award') this.ev.award(String(m.id), Number(m.gate));
    else if (m.k === 'throw' && m.id) this.ev.throw(m.id, m.p);
    else if (m.k === 'splat' && m.id) this.ev.splat(m.id, String(m.by));
    else if (m.k === 'finish' && m.id) this.ev.finish(m.id, m.time);
  }

  /* ------------------------------- shared -------------------------------- */

  sendPose(p: PoseArr): void {
    if (this.isHost) this.relay({ k: 'pose', id: HOST_ID, p });
    else this.hostLink?.send({ k: 'pose', p } satisfies Msg);
  }

  sendFinish(time: number): void {
    if (this.isHost) this.relay({ k: 'finish', id: HOST_ID, time });
    else this.hostLink?.send({ k: 'finish', time } satisfies Msg);
  }

  /* ---------------------------- tomato fight ---------------------------- */

  /** I just passed checkpoint `gate`: ask the host for the tomato */
  claimGate(gate: number): void {
    if (this.isHost) this.grant(HOST_ID, gate);
    else this.hostLink?.send({ k: 'claim', gate } satisfies Msg);
  }

  private grant(id: string, gate: number): void {
    if (!Number.isFinite(gate) || this.claimed.has(gate)) return;
    this.claimed.add(gate);
    this.relay({ k: 'award', id, gate });
    this.ev.award(id, gate);
  }

  sendThrow(p: number[]): void {
    if (this.isHost) this.relay({ k: 'throw', id: HOST_ID, p });
    else this.hostLink?.send({ k: 'throw', p } satisfies Msg);
  }

  /** I got hit by `by` */
  sendSplat(by: string): void {
    if (this.isHost) this.relay({ k: 'splat', id: HOST_ID, by });
    else this.hostLink?.send({ k: 'splat', by } satisfies Msg);
  }

  setCar(style: string, livery: string): void {
    const me = this.me;
    if (me) {
      me.style = style;
      me.livery = livery;
    }
    if (this.isHost) this.broadcastLobby();
    else this.hostLink?.send({ k: 'car', style, livery } satisfies Msg);
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
