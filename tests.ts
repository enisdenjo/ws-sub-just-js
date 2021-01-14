import http from 'http';
import WebSocket from 'ws';
import { connect, makeLazyConnect } from './index';

Object.assign(global, { WebSocket });

let url: string, server: http.Server, ws: WebSocket.Server;

beforeAll(async () => {
  const path = '/lr';
  server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.listen(0);
  ws = new WebSocket.Server({ server, path });
  const addr = server.address();
  if (!addr || typeof addr !== 'object') {
    throw new Error(`Unexpected http server address ${addr}`);
  }
  url = `ws://localhost:${addr.port}${path}`;

  // Acknowledge everyone.
  ws.on('connection', (socket) => {
    setImmediate(() => socket.send('ack'));
  });
});

afterAll(() => {
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
