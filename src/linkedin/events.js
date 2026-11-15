// Tiny server-sent-events hub: the Queue page listens here, so it updates the moment a post changes.
const clients = new Set();
let timer = null;

export function addClient(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  clients.add(res);
  const beat = setInterval(() => res.write(': ping\n\n'), 20_000); // keeps proxies from closing an idle connection
  req.on('close', () => { clearInterval(beat); clients.delete(res); });
}

// Many changes in a row (bulk delete, scheduler loop) become a single message.
export function emitPosts() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const c of clients) c.write(`event: posts\ndata: ${Date.now()}\n\n`);
  }, 150);
}

export function closeAll() { for (const c of clients) c.end(); clients.clear(); }
