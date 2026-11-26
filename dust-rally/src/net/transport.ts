/**
 * Star-topology transports: one host (the room), guests connect only to the host.
 *  - PeerJS: browsers talk directly over WebRTC; PeerJS's free public server only
 *    introduces them (the room code is the host's peer id). Includes PeerJS's TURN relay.
 *  - Local: BroadcastChannel between tabs of the same browser (development / tests: ?net=local).
 */

export interface Link {
  readonly id: string; // remote peer id
  send(data: unknown): void;
  onData: (data: unknown) => void;
  onClose: () => void;
  close(): void;
}

export interface HostTransport {
  onConnection: (link: Link) => void;
  /** the signalling connection was lost for good */
  onError: (msg: string) => void;
  close(): void;
}

export interface NetDriver {
  /** throws Error('taken') if the code is in use */
  host(code: string): Promise<HostTransport>;
  /** throws Error('not-found') if there is no such room */
  join(code: string): Promise<Link>;
}

const PREFIX = 'dustrally-v1-';

/* ------------------------------------------------------------------ */
/* PeerJS                                                               */
/* ------------------------------------------------------------------ */
export async function peerDriver(): Promise<NetDriver> {
  const { Peer } = await import('peerjs');
  type DataConnection = import('peerjs').DataConnection;

  const wrap = (conn: DataConnection): Link => {
    const link: Link = {
      id: conn.peer,
      send: (d) => {
        if (conn.open) conn.send(d);
      },
      onData: () => {},
      onClose: () => {},
      close: () => conn.close(),
    };
    conn.on('data', (d) => link.onData(d));
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      link.onClose();
    };
    conn.on('close', done);
    conn.on('error', done);
    // ICE failures don't always fire 'close'
    conn.peerConnection?.addEventListener('connectionstatechange', () => {
      const st = conn.peerConnection?.connectionState;
      if (st === 'failed' || st === 'closed') done();
    });
    return link;
  };

  return {
    host(code) {
      return new Promise((resolve, reject) => {
        const peer = new Peer(PREFIX + code.toLowerCase());
        let ready = false;
        const t: HostTransport = {
          onConnection: () => {},
          onError: () => {},
          close: () => peer.destroy(),
        };
        peer.on('open', () => {
          ready = true;
          resolve(t);
        });
        peer.on('connection', (conn) => {
          conn.on('open', () => t.onConnection(wrap(conn)));
        });
        peer.on('disconnected', () => {
          // lost the signalling server: existing races keep working, new joins need it
          if (!peer.destroyed) peer.reconnect();
        });
        peer.on('error', (e: Error & { type?: string }) => {
          if (!ready) {
            peer.destroy();
            reject(new Error(e.type === 'unavailable-id' ? 'taken' : e.type === 'network' || e.type === 'server-error' ? 'offline' : e.message));
          } else if (e.type === 'network' || e.type === 'server-error') t.onError('Lost connection to the room server');
        });
      });
    },
    join(code) {
      return new Promise((resolve, reject) => {
        const peer = new Peer();
        let settled = false;
        const fail = (msg: string) => {
          if (settled) return;
          settled = true;
          peer.destroy();
          reject(new Error(msg));
        };
        const timer = setTimeout(() => fail('timeout'), 15000);
        peer.on('open', () => {
          const conn = peer.connect(PREFIX + code.toLowerCase(), { reliable: true, serialization: 'json' });
          conn.on('open', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const link = wrap(conn);
            const close = link.close;
            link.close = () => {
              close();
              peer.destroy();
            };
            resolve(link);
          });
        });
        peer.on('error', (e: Error & { type?: string }) => {
          clearTimeout(timer);
          fail(e.type === 'peer-unavailable' ? 'not-found' : e.type === 'network' || e.type === 'server-error' ? 'offline' : e.message);
        });
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Local (BroadcastChannel)                                             */
/* ------------------------------------------------------------------ */
type LocalMsg =
  | { t: 'ping'; from: string }
  | { t: 'accept'; to: string }
  | { t: 'data'; from: string; to: string; d: unknown }
  | { t: 'close'; from: string; to: string };

export function localDriver(): NetDriver {
  const rid = () => Math.random().toString(36).slice(2, 10);
  const HOST = 'host';
  return {
    async host(code) {
      const ch = new BroadcastChannel('dustrally-' + code);
      // is someone already hosting this code?
      const taken = await new Promise<boolean>((res) => {
        const probe = 'probe-' + rid();
        const on = (e: MessageEvent<LocalMsg>) => {
          if (e.data.t === 'accept' && e.data.to === probe) res(true);
        };
        ch.addEventListener('message', on);
        ch.postMessage({ t: 'ping', from: probe });
        setTimeout(() => {
          ch.removeEventListener('message', on);
          res(false);
        }, 250);
      });
      if (taken) {
        ch.close();
        throw new Error('taken');
      }
      const links = new Map<string, Link>();
      const t: HostTransport = {
        onConnection: () => {},
        onError: () => {},
        close: () => {
          for (const l of links.values()) l.close();
          ch.close();
        },
      };
      ch.onmessage = (e: MessageEvent<LocalMsg>) => {
        const m = e.data;
        if (m.t === 'ping') {
          if (m.from.startsWith('probe-') || links.has(m.from)) {
            ch.postMessage({ t: 'accept', to: m.from });
            return;
          }
          const id = m.from;
          const link: Link = {
            id,
            send: (d) => ch.postMessage({ t: 'data', from: HOST, to: id, d }),
            onData: () => {},
            onClose: () => {},
            close: () => {
              if (!links.delete(id)) return;
              ch.postMessage({ t: 'close', from: HOST, to: id });
            },
          };
          links.set(id, link);
          t.onConnection(link); // attach handlers before the guest can send anything
          ch.postMessage({ t: 'accept', to: id });
        } else if (m.t === 'data' && m.to === HOST) links.get(m.from)?.onData(m.d);
        else if (m.t === 'close' && m.to === HOST) {
          const l = links.get(m.from);
          if (l) {
            links.delete(m.from);
            l.onClose();
          }
        }
      };
      return t;
    },
    join(code) {
      return new Promise((resolve, reject) => {
        const ch = new BroadcastChannel('dustrally-' + code);
        const me = rid();
        let open = false;
        const link: Link = {
          id: HOST,
          send: (d) => open && ch.postMessage({ t: 'data', from: me, to: HOST, d }),
          onData: () => {},
          onClose: () => {},
          close: () => {
            if (!open) return;
            open = false;
            ch.postMessage({ t: 'close', from: me, to: HOST });
            ch.close();
          },
        };
        if (typeof window !== 'undefined') window.addEventListener('pagehide', () => link.close());
        const timer = setTimeout(() => {
          ch.close();
          reject(new Error('not-found'));
        }, 1500);
        ch.onmessage = (e: MessageEvent<LocalMsg>) => {
          const m = e.data;
          if (m.t === 'accept' && m.to === me && !open) {
            clearTimeout(timer);
            open = true;
            resolve(link);
          } else if (m.t === 'data' && m.to === me) link.onData(m.d);
          else if (m.t === 'close' && m.to === me && open) {
            open = false;
            ch.close();
            link.onClose();
          }
        };
        ch.postMessage({ t: 'ping', from: me });
      });
    },
  };
}
