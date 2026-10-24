/**
 * 禁用端口清单、判定，以及「起监听时避开禁用端口」的公共逻辑。
 *
 * 背景（这是个真实会咬人的坑）：
 *
 *   WHATWG Fetch 规范和所有浏览器都内置了一张「坏端口」名单。向这些端口发起的请求
 *   会在**真正发出之前**被直接拒绝（undici 报 `bad port`），连接根本不会建立。
 *   Node 原生的 http.request / https.request **不受**这份名单约束——所以同一个端口，
 *   curl 和自建客户端连得上，浏览器和 fetch 客户端按规范拒绝。
 *
 *   后果：代理如果监听在清单内的端口上，服务端一切正常、日志一片干净，
 *   但客户端「起来了却谁都连不上」。
 *
 *   本清单与当前运行时内置 undici 的 badPortsSet 逐项一致（82 项）。
 *   test/ports.test.mjs 会拿运行时源码逐项核对：Node 升级改了名单，测试会红，
 *   而不是等到用户连不上才发现。
 */

/** 升序、唯一的禁用端口全集（WHATWG Fetch 规范 / undici badPortsSet）。 */
export const FORBIDDEN_PORTS = [
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
];

const FORBIDDEN_PORT_SET = new Set(FORBIDDEN_PORTS);

/**
 * 端口是否在禁用清单里。
 *
 * 只认「整数的端口号」：null / undefined / 字符串 / 小数一律 false，
 * 交给调用方按自己的语义处理（0 表示让系统分配，不在清单内）。
 */
export function isForbiddenPort(port) {
  return typeof port === 'number' && Number.isInteger(port) && FORBIDDEN_PORT_SET.has(port);
}

/**
 * 让 server 监听，并在「系统自动分配的端口命中禁用清单」时换一个。
 *
 * 只轮换 `port === 0` 的情况：那是「随便给我一个端口」，换一个不违背用户意图；
 * 用户显式写下的端口要尊重（哪怕它在清单里），提醒交给 doctor 去做。
 *
 * 轮换做法是 close 之后重新 listen——同一个 server 对象可以反复 listen，
 * Node 会重建内部句柄（test/ports.test.mjs 有覆盖）。
 *
 * @param {import('node:http').Server|import('node:https').Server} server
 * @param {{port?: number, host?: string, maxAttempts?: number,
 *          onAbandon?: (port: number) => void, onGiveUp?: (port: number) => void}} options
 * @returns {Promise<import('node:net').AddressInfo>} 最终监听地址
 */
export async function listenUntilUsablePort(server, options = {}) {
  const {
    port,
    host,
    maxAttempts = 8,
    onAbandon = null,
    onGiveUp = null,
  } = options;

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const address = await new Promise((resolve, reject) => {
      const onStartupError = (error) => {
        server.removeListener('error', onStartupError);
        reject(error);
      };
      server.once('error', onStartupError);
      try {
        server.listen(port, host, () => {
          server.removeListener('error', onStartupError);
          resolve(server.address());
        });
      } catch (error) {
        server.removeListener('error', onStartupError);
        reject(error);
      }
    });

    // 自动分配的端口才有得选；显式配置的端口哪怕在清单里也原样返回
    const forbidden = port === 0 && isForbiddenPort(address && address.port);
    if (!forbidden || attempts >= maxAttempts) {
      if (forbidden && typeof onGiveUp === 'function') onGiveUp(address.port);
      return address;
    }

    if (typeof onAbandon === 'function') onAbandon(address.port);
    await new Promise((resolve) => {
      // 这个端口反正不要了，把它上面可能已经建起来的连接一并收掉，
      // 否则 close() 会一直等下去
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
}
