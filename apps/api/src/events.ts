/**
 * Server-Sent Events helpers.
 *   event: economy  id: <seq>  data: EconomyEvent   (persisted; resumable with Last-Event-ID)
 *   event: state               data: GameStatePublic (after every tick/action; not persisted)
 *   event: tick                data: TickFrame       (lightweight clock frame)
 *   event: replay              data: EconomyEvent    (Observatory playback)
 *   : ping                     (heartbeat comment every 15 s)
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export function openSse(req: FastifyRequest, reply: FastifyReply, allowedOrigin: string | null): (event: string, data: unknown, id?: number) => void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(allowedOrigin ? { "access-control-allow-origin": allowedOrigin, "access-control-allow-credentials": "true", vary: "Origin" } : {}),
  });
  res.write("retry: 2000\n\n");
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.raw.on("close", () => clearInterval(ping));
  return (event, data, id) => {
    if (res.writableEnded) return;
    res.write(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

export function lastEventId(req: FastifyRequest): number {
  const h = req.headers["last-event-id"];
  const q = (req.query as Record<string, string> | undefined)?.lastEventId;
  const v = Number(Array.isArray(h) ? h[0] : (h ?? q ?? 0));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
