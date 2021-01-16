/**
 * Socket
 */

/** For the sake of example, any message is an acknowledgment message. */
function isAckMessage(data: unknown) {
  return String(data) === 'ack';
}

export async function connect(
  url: string,
): Promise<
  [
    socket: WebSocket,
    complete: () => void,
    throwOnCloseOrWaitForComplete: Promise<void>,
  ]
> {
  const socket = new WebSocket(url);

  /**
   * Once promises settle, all following resolve/reject calls will simply
   * be ignored. So, for the sake of simplicity, I wont be unlistening.
   */
  await new Promise<void>((resolve, reject) => {
    /**
     * From: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications
     * > If an error occurs while attempting to connect, first a simple event with the
     * > name error is sent to the WebSocket object (thereby invoking its onerror handler),
     * > and then the CloseEvent is sent to the WebSocket object (thereby invoking its
     * > onclose handler) to indicate the reason for the connection's closing.
     *
     * Keeping this in mind, listening to the `onclose` event is sufficient. Close events
     * (code + reason) should be used to communicate any critical problem with the socket.
     */
    socket.onclose = reject;

    /**
     * Sometimes the socket opens and closes right after, so try relying an acknowledgment
     * message from the server to confirm the connection instead of the `onopen` event.
     */
    socket.onmessage = ({ data }) =>
      isAckMessage(data) ? resolve() : reject(new Error("Didn't acknowledge!"));
  });

  return [
    socket,
    () => socket.close(1000, 'Normal Closure'), // normal closure is completion
    /**
     * The promise is the state flag. If pending, socket is active; if rejected,
     * socket closed; and if resolved, socket completed.
     */
    new Promise<void>(
      (resolve, reject) =>
        (socket.onclose = (event) =>
          event.code === 1000 ? resolve() : reject(event)),
    ),
  ];
}

export function makeLazyConnect(
  url: string,
): () => Promise<
  [
    socket: WebSocket,
    release: () => void,
    throwOnCloseOrWaitForRelease: Promise<void>,
  ]
> {
  let connecting: ReturnType<typeof connect>,
    locks = 0;
  return async function lazyConnect() {
    /**
     * A new lazy connection is established, increment the locks.
     * Once all locks are released, the actual socket connection will
     * complete.
     */
    locks++;
    let release = () => {
      /**
       * Release the lazy connect lock. The actual decrementation
       * happens below, in the release waiter. Note that this function
       * will be replaced with the `released` resolve function in the
       * following promise.
       */
    };
    const released = new Promise<void>((resolve) => (release = resolve));

    /**
     * Promises can resolve only once and will return the fullfiled value
     * on each subsequent call. So we simply reuse the connect promise.
     */
    if (!connecting) connecting = connect(url);
    const [socket, complete, throwOnCloseOrWaitForComplete] = await connecting;

    return [
      socket,
      release,
      Promise.race([
        released.then(() => {
          /**
           * Release the lock by decrementing the locks.
           */

          if (--locks === 0) {
            /**
             * If no lazy connection locks exist anymore, complete
             * the actual socket conection.
             */
            complete();
          }
        }),
        throwOnCloseOrWaitForComplete
          /**
           * Complete or close, both close the socket, create
           * a new one on next connect.
           */
          .finally(() => (connecting = null)),
      ]),
    ];
  };
}

/**
 * Subscription
 */

export interface RequestMsg {
  id: number;
  request: string;
}

export interface ResponseMsg {
  id: number;
  response: string;
}

export interface CompleteMsg {
  complete: number;
}

let hellosId = 0;
export async function subscribe(
  connect: ReturnType<typeof makeLazyConnect>,
  request: string,
  listener: (response: string) => void,
): Promise<[waitForCompleteOrThrow: Promise<void>, complete: () => void]> {
  const [socket, release, throwOnCloseOrWaitForRelease] = await connect();

  const id = hellosId++;
  socket.send(JSON.stringify({ id, request } as RequestMsg));

  socket.addEventListener('message', onMessage);
  function onMessage({ data }: MessageEvent) {
    const msg = JSON.parse(data) as ResponseMsg | CompleteMsg;
    if ('complete' in msg && msg.complete === id) {
      release();
    } else if ('id' in msg && msg.id === id) {
      listener(msg.response);
    }
  }

  return [
    /**
     * Releasing the connection happens after completing
     * subscription.
     */
    throwOnCloseOrWaitForRelease.finally(() =>
      socket.removeEventListener('message', onMessage),
    ),
    () => {
      socket.send(JSON.stringify({ complete: id } as CompleteMsg));
      release();
    },
  ];
}
