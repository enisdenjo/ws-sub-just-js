import http from 'http';
import WebSocket from 'ws';
import {
  connect,
  makeLazyConnect,
  subscribe,
  ID,
  RequestMsg,
  ResponseMsg,
  CompleteMsg,
} from './index';

Object.assign(global, { WebSocket });

function waitABit(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

let url: string, server: http.Server, ws: WebSocket.Server;

beforeAll(async () => {
  const path = '/lr';
  server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  ws = new WebSocket.Server({ server, path });

  // Acknowledge everyone.
  ws.on('connection', (socket) => {
    setImmediate(() => socket.send('ack'));
    const wavers: Record<ID, NodeJS.Timeout> = {};
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RequestMsg | CompleteMsg;
      if ('complete' in msg) {
        clearInterval(wavers[msg.complete]);
      } else if ('id' in msg) {
        if (msg.request === 'givemewaves') {
          wavers[msg.id] = setInterval(
            () =>
              socket.send(
                JSON.stringify({
                  id: msg.id,
                  response: '🌊',
                } as ResponseMsg),
              ),
            1000,
          );
        } else {
          // handle other type of requests
        }
      }
    });
  });

  server.listen(0);

  const addr = server.address();
  if (typeof addr !== 'object') {
    throw new Error(`Unexpected http server address ${addr}`);
  }
  url = `ws://localhost:${addr.port}${path}`;
});

afterAll(() => {
  // TODO-db-210116 terminate server instead of close
  server.close();
});

it('should connect after acknowledgment', async () => {
  const [socket] = await connect(url);

  expect(socket.readyState).toBe(WebSocket.OPEN);
});

it('should close socket with 1000 on complete', async (done) => {
  const [socket, complete] = await connect(url);
  socket.onclose = ({ code }) => {
    expect(code).toBe(1000);
    done();
  };
  complete();
});

describe('Lazy', () => {
  it('should lazy connect on first connect', async () => {
    const connect = await makeLazyConnect(url);
    const [socket] = await connect();
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('should reuse the same socket on further lazy connects', async () => {
    const connect = await makeLazyConnect(url);
    const [socket1] = await connect();
    const [socket2] = await connect();
    const [socket3] = await connect();
    expect(socket1).toBe(socket2);
    expect(socket2).toBe(socket3);
  });

  it('should keep connection until last lazy connection completes', async (done) => {
    const connect = await makeLazyConnect(url);
    const [socket, complete1] = await connect();
    const [, complete2] = await connect();
    const [, complete3] = await connect();
    complete1();
    await waitABit();
    expect(socket.readyState).toBe(WebSocket.OPEN);

    complete2();
    await waitABit();
    expect(socket.readyState).toBe(WebSocket.OPEN);

    complete3();
    socket.onclose = () => done();
  });

  it('should throw on close', async (done) => {
    const connect = await makeLazyConnect(url);
    const [socket, , throwOnCloseOrWaitForRelease] = await connect();
    socket.close(4000);
    socket.onclose;
    try {
      await throwOnCloseOrWaitForRelease;
      fail("Should've thrown");
    } catch (err) {
      expect(err.code).toBe(4000);
      done();
    }
  });
});

describe('Subscribe', () => {
  it('should subscribe and listen for related messages', async () => {
    const connect = await makeLazyConnect(url);

    const [complete, waitForCompleteOrThrow] = await subscribe(
      connect,
      'givemewaves',
      (res) => {
        expect(res).toBe('🌊');
        complete();
      },
    );

    await waitForCompleteOrThrow;
  });
});
