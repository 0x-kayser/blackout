/**
 * End-to-end over a real socket: session -> run -> SSE stream -> act -> events
 * arrive with ids -> reconnect with Last-Event-ID resumes without duplicates.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/api/src/server.ts";
import { loadChainConfig } from "../../apps/api/src/chain.ts";
import { startDriver } from "../../apps/api/src/workers.ts";

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let base = "";
let stop = () => {};

beforeAll(async () => {
  built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), allowedOrigins: [] });
  stop = startDriver(built.svc, 50);
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = built.app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  stop();
  await built.app.close();
  built.db.close();
});

interface Frame {
  event: string;
  id?: number;
  data: any;
}

async function readFrames(url: string, headers: Record<string, string>, until: (f: Frame[]) => boolean, ms = 5_000): Promise<Frame[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const res = await fetch(url, { headers, signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: Frame[] = [];
  try {
    while (!until(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const f: Frame = { event: "message", data: null };
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event: ")) f.event = line.slice(7);
          else if (line.startsWith("id: ")) f.id = Number(line.slice(4));
          else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
        }
        if (f.data !== null) frames.push(f);
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return frames;
}

describe("SSE", () => {
  it("streams economy events with ids and resumes from Last-Event-ID", async () => {
    const s: any = await (await fetch(`${base}/api/session/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const token = s.token as string;
    const run: any = await (await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ seed: 5 }) })).json();
    const runId = run.state.run.runId as string;
    // connecting via ?token= (EventSource cannot send headers) starts the clock
    const first = await readFrames(`${base}/api/runs/${runId}/events?token=${token}`, {}, (f) => f.some((x) => x.event === "economy" && x.data.type === "CUSTOMER_REQUESTED"), 4_000);
    const econ = first.filter((f) => f.event === "economy");
    expect(econ[0].id).toBe(1);
    expect(econ.map((f) => f.id)).toEqual(econ.map((_, i) => i + 1));
    expect(first.some((f) => f.event === "state" && f.data.schemaVersion === "blackout.state.v1")).toBe(true);
    const lastId = econ[econ.length - 1].id!;
    const resumed = await readFrames(`${base}/api/runs/${runId}/events`, { authorization: `Bearer ${token}`, "last-event-id": String(lastId) }, (f) => f.some((x) => x.event === "state"), 3_000);
    const resumedIds = resumed.filter((f) => f.event === "economy").map((f) => f.id!);
    expect(resumedIds.every((id) => id > lastId)).toBe(true);
  });

  it("rejects SSE without a valid session", async () => {
    const r = await fetch(`${base}/api/runs/run_x/events?token=nope`);
    expect(r.status).toBe(401);
  });
});
