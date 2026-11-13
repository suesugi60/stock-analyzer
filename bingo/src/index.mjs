// 入口。/ws だけを部屋(Durable Object)へ渡す。画面のファイルは静的ファイルとして配られる。
export { BingoRoom } from './room.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('WebSocket で接続してください', { status: 426 });
      }
      return env.ROOM.get(env.ROOM.idFromName('main')).fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
