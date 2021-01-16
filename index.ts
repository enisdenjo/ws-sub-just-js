/**
 * Socket
 */

/**
 * A simple WebSocket connect function that resolves once the socket
 * opens and the server acknowledges the connection.
 */
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
     * > If an error occurs while attempting to connect, first a simple event
     * > with the name error is sent to the WebSocket object (thereby invoking
     * > its onerror handler), and then the CloseEvent is sent to the WebSocket
     * > object (thereby invoking its onclose handler) to indicate the reason for
     * > the connection's closing.
     *
     * Keeping this in mind, listening to the `onclose` event is sufficient.
     * Close events (code + reason) should be used to communicate any critical
     * problem with the socket.
     */
    socket.onclose = reject;

    /**
     * Sometimes the socket opens and closes right after, so try relying an
     * acknowledgment message from the server to confirm the connection instead
     * of the `onopen` event.
     */
    socket.onmessage = ({ data }) =>
      String(data) === 'ack'
        ? resolve()
        : reject(new Error("Didn't acknowledge!"));
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

/**
 * Makes a lazy connect function that establishes a connection
 * on first connect and closes it on last disconnect.
 */
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

/** A globally unique ID used for connecting responses. */
export type ID = number;

/**
 * The request message for starting a subscriptions. Holds
 * the unique ID for connecting future responses.
 */
export interface RequestMsg {
  id: ID;
  request: string;
}

/**
 * The response message for an active subscription. ID would
 * be the same one as requested in the request message.
 */
export interface ResponseMsg {
  id: ID;
  response: string;
}

/**
 * The complete message indicating that the subscription behind
 * the ID is done and will not be emitting anymore events. Complete
 * message is bi-directional so both the server and the client
 * can complete a subscription.
 */
export interface CompleteMsg {
  complete: ID;
}

/**
 * Isolated, self sustained, unit that has all the necessary logic built
 * right in. It establishes a lazy connection with the configured server,
 * silently retries on abrupt closures, generates unique subscription IDs,
 * dispatches relevant messages to the listener, offers a stop method (complete)
 * which closes the lazy connection on last unsubscribe and a promise that resolves
 * on completions and rejects on possible problems that might occur with the socket.
 */
let currId = 0;
export async function subscribe(
  connect: ReturnType<typeof makeLazyConnect>,
  request: string,
  listener: (response: string) => void,
): Promise<[complete: () => void, waitForCompleteOrThrow: Promise<void>]> {
  /**
   * A reference to the completer which will be replaced with a new
   * complete function once the connection is established and the
   * subscription is requested. If the user completes the subscription
   * early (before having connected), the `completed` flag is used
   * to release the connection lock ASAP.
   */
  let completed = false;
  const completerRef = {
    current: () => {
      /** For handling early completions. */
      completed = true;
    },
  };

  const waitForCompleteOrThrow = (async () => {
    for (;;) {
      try {
        const [socket, release, throwOnCloseOrWaitForRelease] = await connect();

        /**
         * If the user completed the subscription before the connection,
         * release it right away - we dont need it.
         */
        if (completed) return release();

        /**
         * Subscribe and listen...
         */
        const id = currId++;
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

        /**
         * Assign a new completer which notifies the server that we are
         * done with the subscription, removes the socket message listener
         * and releases the lazy connection lock.
         */
        completerRef.current = () => {
          socket.send(JSON.stringify({ complete: id } as CompleteMsg));
          release();
        };

        /**
         * Completing the subscription releases the connection lock,
         * waiting for the release is the same as waiting for the complete.
         */
        await throwOnCloseOrWaitForRelease;
        socket.removeEventListener('message', onMessage);
        return;
      } catch (err) {
        if ('code' in err && err.code === 1006) {
          /**
           * Its completely up to you when you want to retry, I've chosen
           * to retry on the CloseEvent code 1006 as it is used when the
           * socket connection closes abruptly (for example: due to client
           * network issues).
           */
          continue;
        } else {
          /**
           * All other errors are considered fatal, rethrow them to break
           * the loop and report to the caller.
           */
          throw err;
        }
      }
    }
  })();

  return [() => completerRef.current(), waitForCompleteOrThrow];
}
