/**
 * Player-to-player plant sales. A company lists one of its plants at a price; another company buys it.
 *
 *   list    the plant is locked in the seller's region (no selling it twice) and, on NEAR, its NFT is listed by the
 *           operator for the seller (`plant_list`; the seller's wallet is in game custody)
 *   buy     the buyer's price is held in their region at once, then ONE transaction (`plant_buy_for`) moves the
 *           buyer's credits to the seller and the NFT to the buyer, atomically. Only when NEAR confirms it does the
 *           plant leave the seller's grid and join the buyer's, where it stood, with its health and charge.
 *   fails   the held price goes back to the buyer and the listing stays open. Nothing half-happens.
 * Without a chain (local mode) the same steps run at once on the game server.
 */
import { randomUUID } from "node:crypto";
import { region } from "@blackout/sim";
import { nowIso, type Db } from "../db.ts";
import type { RegionService } from "../region.ts";
import { ApiError } from "../services.ts";
import type { EconomyService, OpRow } from "./service.ts";

export interface SaleRow {
  sale_id: string;
  seller_id: string;
  seller_region: string;
  plant_id: string;
  token_id: string | null;
  name: string;
  tech: string;
  node_id: string;
  capacity_kw: number;
  price_cc: number;
  status: "listing" | "listed" | "buying" | "sold" | "cancelled" | "failed";
  buyer_id: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlantSaleView {
  saleId: string;
  sellerName: string;
  mine: boolean;
  name: string;
  tech: string;
  nodeId: string;
  capacityKw: number;
  priceCc: number;
  status: SaleRow["status"];
  tokenId: string | null;
  tokenUrl: string | null;
  detail: string | null;
}

export class PlantMarket {
  constructor(
    private readonly db: Db,
    private readonly eco: EconomyService,
    private readonly rsvc: RegionService,
  ) {
    eco.saleHooks = { settled: (r) => this.onSettled(r), failed: (r, d) => this.onFailed(r, d) };
  }

  private sale(id: string): SaleRow | null {
    return (this.db.prepare("SELECT * FROM plant_sales WHERE sale_id = ?").get(id) as SaleRow | undefined) ?? null;
  }
  private setStatus(id: string, status: SaleRow["status"], detail: string | null = null, buyer?: string | null): void {
    this.db.prepare(`UPDATE plant_sales SET status = ?, detail = ?, ${buyer !== undefined ? "buyer_id = ?," : ""} updated_at = ? WHERE sale_id = ?`).run(...([status, detail, ...(buyer !== undefined ? [buyer] : []), nowIso(), id] as (string | null)[]));
  }
  private act(userId: string, action: Parameters<RegionService["act"]>[1], key: string) {
    const h = this.rsvc.liveFor(userId);
    const r = this.rsvc.act(h, action, key, "system");
    if (!r.ok) throw new ApiError((r.error?.code as never) ?? "INVALID_STATE", r.error?.message ?? "Refused.");
    return h;
  }

  list(userId: string, plantId: string, priceCc: number): SaleRow {
    const h = this.rsvc.liveFor(userId);
    const p = h.state.plants.find((x) => x.plantId === plantId && x.ownerId === "player");
    if (!p) throw new ApiError("NOT_FOUND", "That plant isn't yours.");
    if (p.status === "building") throw new ApiError("INVALID_STATE", "Finish building it first.");
    if (this.db.prepare("SELECT 1 FROM plant_sales WHERE seller_id = ? AND plant_id = ? AND status IN ('listing', 'listed', 'buying')").get(userId, plantId)) throw new ApiError("INVALID_STATE", "It's already for sale.");
    const token = p.chainTokenId ?? this.eco.plantTokenId(h.regionId, p.assetNo);
    if (this.eco.live) {
      if (!this.eco.activeAccount(userId)) throw new ApiError("INVALID_STATE", "Your wallet isn't open yet.");
      if (this.eco.op(`plant:${token}`)?.status !== "settled") throw new ApiError("INVALID_STATE", "This plant is still being registered on NEAR. Try again in a minute.");
    }
    const saleId = `s${randomUUID().slice(0, 12)}`;
    this.act(userId, { type: "PLANT_LOCK", plantId, locked: true }, `sale-lock:${saleId}`);
    const at = nowIso();
    this.db
      .prepare("INSERT INTO plant_sales (sale_id, seller_id, seller_region, plant_id, token_id, name, tech, node_id, capacity_kw, price_cc, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(saleId, userId, h.regionId, plantId, token, p.name, p.tech, p.nodeId, p.capacityKw, priceCc, this.eco.live ? "listing" : "listed", at, at);
    if (this.eco.live) this.eco.enqueue({ opId: `sale-list:${saleId}`, kind: "plant", subject: `sale:${saleId}`, signer: "operator", method: "plant_list", args: { token_id: token, price: String(priceCc) } });
    return this.sale(saleId)!;
  }

  cancel(userId: string, saleId: string): void {
    const s = this.sale(saleId);
    if (!s || s.seller_id !== userId) throw new ApiError("NOT_FOUND", "No such listing.");
    if (s.status !== "listed" && s.status !== "listing") throw new ApiError("INVALID_STATE", s.status === "buying" ? "Someone is buying it right now." : "It's no longer for sale.");
    this.setStatus(saleId, "cancelled", "withdrawn by the seller");
    this.act(userId, { type: "PLANT_LOCK", plantId: s.plant_id, locked: false }, `sale-unlock:${saleId}`);
    if (this.eco.live) this.eco.enqueue({ opId: `sale-cancel:${saleId}`, kind: "plant", subject: `sale:${saleId}`, signer: "operator", method: "plant_cancel_listing", args: { token_id: s.token_id } });
  }

  buy(userId: string, saleId: string): SaleRow {
    const s = this.sale(saleId);
    if (!s || s.status !== "listed") throw new ApiError("INVALID_STATE", "It's no longer for sale.");
    if (s.seller_id === userId) throw new ApiError("INVALID_STATE", "That's your own plant.");
    const wallet = this.eco.live ? this.eco.activeAccount(userId) : null;
    if (this.eco.live && !wallet) throw new ApiError("INVALID_STATE", "Your wallet isn't open yet.");
    // the price is held at once, so it can't be spent twice while NEAR confirms the sale
    this.act(userId, { type: "PLANT_PAYMENT", saleId, cc: s.price_cc, hold: true, sellerName: this.rsvc.nameOf(s.seller_id) }, `sale-hold:${saleId}:${userId}`);
    this.setStatus(saleId, "buying", null, userId);
    if (this.eco.live) this.eco.enqueue({ opId: `sale-buy:${saleId}`, kind: "plant", subject: `sale:${saleId}`, signer: "operator", method: "plant_buy_for", args: { buyer_id: wallet, token_id: s.token_id } });
    else this.complete(saleId);
    return this.sale(saleId)!;
  }

  /** The sale is final: the plant leaves the seller's grid and joins the buyer's. */
  private complete(saleId: string): void {
    const s = this.sale(saleId)!;
    if (s.status !== "buying" || !s.buyer_id) return;
    const sellerH = this.rsvc.liveFor(s.seller_id);
    const p = sellerH.state.plants.find((x) => x.plantId === s.plant_id && x.ownerId === "player");
    const snapshot = p
      ? { name: p.name, tech: p.tech, nodeId: p.nodeId, capacityKw: p.capacityKw, energyKwh: p.energyKwh, healthBps: p.healthBps, socKwh: p.socKwh, cycles: p.cycles, chainTokenId: s.token_id }
      : { name: s.name, tech: s.tech as never, nodeId: s.node_id as never, capacityKw: s.capacity_kw, energyKwh: 0, healthBps: 10_000, socKwh: 0, cycles: 0, chainTokenId: s.token_id };
    const buyerName = this.rsvc.nameOf(s.buyer_id);
    const sellerName = this.rsvc.nameOf(s.seller_id);
    if (p) this.act(s.seller_id, { type: "PLANT_OUT", saleId, plantId: s.plant_id, buyerName, priceCc: s.price_cc }, `sale-out:${saleId}`);
    this.act(s.buyer_id, { type: "PLANT_IN", saleId, sellerName, priceCc: s.price_cc, plant: snapshot }, `sale-in:${saleId}`);
    this.setStatus(saleId, "sold", `sold to ${buyerName}`);
  }

  private onSettled(row: OpRow): void {
    const id = row.subject?.startsWith("sale:") ? row.subject.slice(5) : null;
    if (!id) return;
    if (row.method === "plant_list" && this.sale(id)?.status === "listing") this.setStatus(id, "listed");
    if (row.method === "plant_buy_for") this.complete(id);
  }

  private onFailed(row: OpRow, detail: string): void {
    const id = row.subject?.startsWith("sale:") ? row.subject.slice(5) : null;
    const s = id ? this.sale(id) : null;
    if (!s) return;
    if (row.method === "plant_list") {
      this.setStatus(s.sale_id, "failed", `NEAR refused the listing: ${detail.slice(0, 120)}`);
      try {
        this.act(s.seller_id, { type: "PLANT_LOCK", plantId: s.plant_id, locked: false }, `sale-unlock:${s.sale_id}`);
      } catch {
        /* the plant is gone */
      }
    }
    if (row.method === "plant_buy_for" && s.status === "buying" && s.buyer_id) {
      // the buyer gets their money back; the plant stays listed for someone else
      this.act(s.buyer_id, { type: "PLANT_PAYMENT", saleId: s.sale_id, cc: s.price_cc, hold: false, sellerName: this.rsvc.nameOf(s.seller_id) }, `sale-release:${s.sale_id}:${s.buyer_id}`);
      this.setStatus(s.sale_id, "listed", "a purchase didn't go through; still for sale", null);
    }
  }

  view(userId: string | null): PlantSaleView[] {
    const rows = this.db.prepare("SELECT * FROM plant_sales WHERE status IN ('listing', 'listed', 'buying') OR (seller_id = ? AND updated_at > ?) ORDER BY created_at DESC LIMIT 40").all(userId ?? "", new Date(Date.now() - 86_400_000).toISOString()) as unknown as SaleRow[];
    return rows.map((r) => ({
      saleId: r.sale_id,
      sellerName: r.seller_id === userId ? "You" : this.rsvc.nameOf(r.seller_id),
      mine: r.seller_id === userId,
      name: r.name,
      tech: r.tech,
      nodeId: r.node_id,
      capacityKw: r.capacity_kw,
      priceCc: r.price_cc,
      status: r.status,
      tokenId: r.token_id,
      tokenUrl: this.eco.live && r.token_id ? `${this.eco.cfg.explorerAccountBase}${r.token_id}.${this.eco.cfg.contractId}` : null,
      detail: r.detail,
    }));
  }
}

void region;
