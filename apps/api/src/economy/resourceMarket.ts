/**
 * Player-owned NEP-245 listings on the root Vesper Market.
 *
 * A listing removes the offered quantity from the player's usable region inventory before it can be escrowed.
 * The contract then holds the exact tokens until a confirmed cancellation or an atomic NPC resource/credit fill.
 * Unknown chain outcomes remain reserved and are reconciled through EconomyService's listing view.
 */
import { randomUUID } from "node:crypto";
import type { ItemId } from "@blackout/shared";
import { ITEMS } from "@blackout/shared";
import { region, town } from "@blackout/sim";
import { nowIso, type Db } from "../db.ts";
import type { RegionHandle, RegionService } from "../region.ts";
import type { TownService, Trader } from "../town.ts";
import { ApiError } from "../services.ts";
import type { EconomyService, OpRow } from "./service.ts";
import { TRANSIENT } from "./gateway.ts";

type ResourceSaleStatus = "listing" | "listed" | "buying" | "cancelling" | "sold" | "cancelled" | "failed";

interface ResourceSaleRow {
  sale_id: string;
  idempotency_key: string;
  seller_id: string;
  seller_region: string;
  seller_account_id: string | null;
  item_id: ItemId;
  token_id: string;
  quantity: number;
  unit_price_cc: number;
  fill_attempt: number;
  cancel_attempt: number;
  status: ResourceSaleStatus;
  buyer_id: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceSaleView {
  saleId: string;
  sellerName: string;
  mine: boolean;
  item: ItemId;
  quantity: number;
  unitPriceCc: number;
  totalCc: number;
  status: ResourceSaleStatus;
  buyerName: string | null;
  decision: string;
  createdAt: string;
}

export interface ResourceListingInput {
  item: ItemId;
  quantity: number;
  unitPriceCc: number;
  idempotencyKey: string;
}

const RESOURCE_UNITS = region.regionConfig.TOWN_UNITS;
const REASONABLE_MAX_QUANTITY = 1_000_000_000;
const cash = (cc: number) => `₡${(cc / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export class ResourceMarket {
  private busy = false;

  constructor(
    private readonly db: Db,
    private readonly eco: EconomyService,
    private readonly rsvc: RegionService,
    private readonly tsvc: TownService,
  ) {
    eco.resourceMarketHooks = { settled: (row) => this.onSettled(row), failed: (row, detail) => this.onFailed(row, detail) };
  }

  view(viewer: string | null): ResourceSaleView[] {
    const rows = this.db.prepare(
      "SELECT * FROM resource_sales ORDER BY CASE WHEN status IN ('listing','listed','buying','cancelling') THEN 0 ELSE 1 END, updated_at DESC LIMIT 60",
    ).all() as unknown as ResourceSaleRow[];
    return rows.map((row) => this.toView(row, viewer));
  }

  async list(userId: string, h: RegionHandle, input: ResourceListingInput): Promise<ResourceSaleView> {
    const prior = this.db.prepare("SELECT * FROM resource_sales WHERE seller_id = ? AND idempotency_key = ?").get(userId, input.idempotencyKey) as ResourceSaleRow | undefined;
    if (prior) {
      this.ensureCreate(prior);
      return this.toView(this.sale(prior.sale_id)!, userId);
    }
    this.assertListingInput(input);
    const held = this.tsvc.held(h, input.item);
    if (held < input.quantity) throw new ApiError("REQUIREMENT_NOT_MET", `You have ${held.toLocaleString("en-US")} ${ITEMS[input.item].units}; keep enough in reserve for your next move.`);

    let accountId: string | null = null;
    if (this.eco.live) {
      accountId = this.activePlayerWallet(userId);
      const actual = await this.eco.onChainTokenBalance(accountId, input.item);
      if (actual === null) throw new ApiError("CHAIN_UNAVAILABLE", "The market cannot verify your available resource balance yet. Try again in a moment.");
      if (actual !== held) throw new ApiError("INVALID_STATE", "Your recent resource movements are still settling. Try again when the market has synced.");
    }

    const saleId = `r${randomUUID().replace(/-/g, "").slice(0, 18)}`;
    const at = nowIso();
    this.db.prepare(
      `INSERT INTO resource_sales (sale_id, idempotency_key, seller_id, seller_region, seller_account_id, item_id, token_id, quantity, unit_price_cc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(saleId, input.idempotencyKey, userId, h.regionId, accountId, input.item, input.item, input.quantity, input.unitPriceCc, this.eco.live ? "listing" : "listed", at, at);
    this.ensureCreate(this.sale(saleId)!);
    const sale = this.sale(saleId)!;
    if (sale.status === "failed") throw new ApiError("REQUIREMENT_NOT_MET", sale.detail ?? "That listing could not be reserved.");
    // Keep the name and request durable so a retry after a process restart returns the same result.
    this.db.prepare("INSERT OR IGNORE INTO town_actions (user_id, idempotency_key, kind, request_json, result_json, created_at) VALUES (?, ?, 'resource-list', ?, ?, ?)")
      .run(userId, `resource-list:${input.idempotencyKey}`, JSON.stringify(input), JSON.stringify({ saleId }), at);
    return this.toView(sale, userId);
  }

  cancel(userId: string, saleId: string): ResourceSaleView {
    const row = this.sale(saleId);
    if (!row || row.seller_id !== userId) throw new ApiError("NOT_FOUND", "That listing is not yours.");
    if (row.status === "cancelled" || row.status === "failed") return this.toView(row, userId);
    if (row.status === "sold") throw new ApiError("INVALID_STATE", "That resource has already sold.");
    if (row.status === "cancelling") return this.toView(row, userId);
    if (row.status !== "listing" && row.status !== "listed" && row.status !== "buying") throw new ApiError("INVALID_STATE", "That listing cannot be withdrawn right now.");

    if (!this.eco.live) {
      this.setStatus(row.sale_id, "cancelling", "Returning the reserved stock.");
      this.restoreInventory(row, "The listing was withdrawn.");
      this.setStatus(row.sale_id, "cancelled", "Withdrawn. The resources are back in your inventory.");
      return this.toView(this.sale(row.sale_id)!, userId);
    }

    this.db.prepare("UPDATE resource_sales SET status = 'cancelling', cancel_attempt = cancel_attempt + 1, detail = ?, updated_at = ? WHERE sale_id = ?")
      .run("Withdrawal requested. Your resources return when the current market action resolves.", nowIso(), row.sale_id);
    const cancelling = this.sale(row.sale_id)!;
    this.ensureCreate(cancelling);
    this.ensureCancel(row.sale_id);
    return this.toView(this.sale(row.sale_id)!, userId);
  }

  /** Called by the server driver. Settled/failed operations are replay-safe and listed offers are evaluated autonomously. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.reconcileRows();
      const pendingPurchase = this.db.prepare("SELECT * FROM resource_sales WHERE status = 'buying' ORDER BY created_at LIMIT 1").get() as ResourceSaleRow | undefined;
      if (pendingPurchase) {
        this.ensurePurchaseOperation(pendingPurchase);
        return;
      }
      if (this.db.prepare("SELECT 1 FROM resource_sales WHERE status = 'cancelling' LIMIT 1").get()) return;
      const due = this.db.prepare("SELECT * FROM resource_sales WHERE status = 'listed' AND updated_at <= ? ORDER BY updated_at, created_at LIMIT 1").get(new Date(Date.now() - 5_000).toISOString()) as ResourceSaleRow | undefined;
      if (!due) return;
      const result = await this.decide(due);
      if (!result.buyer) {
        this.setStatus(due.sale_id, "listed", result.reason);
        return;
      }
      this.beginPurchase(due, result.buyer, result.reason);
    } finally {
      this.busy = false;
    }
  }

  private assertListingInput(input: ResourceListingInput): void {
    if (!(input.item in RESOURCE_UNITS)) throw new ApiError("VALIDATION_FAILED", "That resource cannot be listed.");
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > REASONABLE_MAX_QUANTITY) throw new ApiError("VALIDATION_FAILED", "Choose a positive, whole quantity.");
    if (!Number.isSafeInteger(input.unitPriceCc) || input.unitPriceCc < 1 || input.unitPriceCc > 1_000_000_000) throw new ApiError("VALIDATION_FAILED", "Choose a price between ₡0.01 and ₡10,000,000 per unit.");
    if (!Number.isSafeInteger(input.unitPriceCc * input.quantity)) throw new ApiError("VALIDATION_FAILED", "That order is too large.");
    if (!/^[a-zA-Z0-9:_-]{8,80}$/.test(input.idempotencyKey)) throw new ApiError("VALIDATION_FAILED", "Refresh the listing form and try again.");
  }

  private activePlayerWallet(userId: string): string {
    let account = this.eco.activeAccount(userId);
    if (!account) {
      this.eco.ensureWallet(userId);
      account = this.eco.activeAccount(userId);
    }
    const wallet = this.eco.wallet(userId);
    if (!account || !wallet || wallet.status !== "active") throw new ApiError("INVALID_STATE", "Your company account is still preparing. Try again in a moment.");
    if (wallet.resource_opened_interval === null || wallet.resource_opened_town_tick === null || wallet.resource_pending_op_id) {
      throw new ApiError("INVALID_STATE", "Your recent resource movements are still settling. Try again in a moment.");
    }
    return account;
  }

  private ensureCreate(row: ResourceSaleRow): void {
    if (row.status === "sold" || row.status === "cancelled" || row.status === "failed") return;
    const h = this.region(row);
    const reserved = this.rsvc.act(h, {
      type: "TOWN_SETTLE",
      ref: `resource-list:${row.sale_id}`,
      reason: `Reserved ${row.quantity.toLocaleString("en-US")} ${ITEMS[row.item_id].units} for a player listing`,
      items: { [row.item_id]: -row.quantity },
    }, `resource-list:${row.sale_id}`, "system");
    if (!reserved.ok) {
      this.setStatus(row.sale_id, "failed", reserved.error?.message ?? "The resources could not be reserved.");
      return;
    }
    if (!this.eco.live) {
      if (row.status === "listing") this.setStatus(row.sale_id, "listed", "Simulation listing is open. NPC merchants are evaluating the offer.");
      return;
    }
    const opId = `resource-list:${row.sale_id}`;
    if (this.eco.op(opId)) return;
    this.eco.enqueue({
      opId,
      kind: "market",
      subject: this.subject(row),
      signer: "operator",
      method: "resource_listing_create",
      args: { seller_id: row.seller_account_id, listing_id: row.sale_id, token_id: row.token_id, amount: String(row.quantity), unit_price_cc: String(row.unit_price_cc) },
    });
  }

  private ensureCancel(saleId: string): void {
    const row = this.sale(saleId);
    if (!row || row.status !== "cancelling" || !this.eco.live) return;
    const create = this.eco.op(`resource-list:${saleId}`);
    if (!create || create.status !== "settled") return;
    const cancelId = this.cancelOpId(row);
    if (!cancelId || this.eco.op(cancelId)) return;
    // If an NPC fill is already in flight, let it resolve first. A final sale wins; a failed purchase proceeds to cancel.
    const fillId = this.fillOpId(row);
    const fill = fillId ? this.eco.op(fillId) : null;
    if (fill?.status === "settled") {
      this.onSettled(fill);
      return;
    }
    if (fill && (fill.status === "created" || fill.status === "submitted" || (fill.status === "failed" && !this.finalFailure(fill)))) return;
    this.eco.enqueue({
      opId: cancelId,
      kind: "market",
      subject: this.subject(row),
      signer: "operator",
      method: "resource_listing_cancel",
      args: { listing_id: saleId },
    });
  }

  private reconcileRows(): void {
    const rows = this.db.prepare("SELECT * FROM resource_sales WHERE status IN ('listing','buying','cancelling') ORDER BY created_at LIMIT 120").all() as unknown as ResourceSaleRow[];
    for (const row of rows) {
      if (row.status === "listing") {
        this.ensureCreate(row);
        const op = this.eco.op(`resource-list:${row.sale_id}`);
        if (op?.status === "settled") this.onSettled(op);
        else if (op?.status === "failed" && this.finalFailure(op)) this.onFailed(op, op.detail ?? "The escrow did not settle.");
      } else if (row.status === "buying" && !this.eco.live) {
        const buyer = row.buyer_id ? town.merchantConfig(row.buyer_id) : null;
        if (buyer) {
          const total = row.quantity * row.unit_price_cc;
          if (!this.tsvc.hasResourceListingCash(row.sale_id, total)) this.tsvc.reserveResourceListingCash(row.sale_id, buyer.merchantId, total);
          this.completePurchase(row);
        }
      } else if (row.status === "buying") {
        const fillId = this.fillOpId(row);
        const op = fillId ? this.eco.op(fillId) : null;
        if (!op) this.ensurePurchaseOperation(row);
        else if (op.status === "settled") this.onSettled(op);
        else if (op.status === "failed" && this.finalFailure(op)) this.onFailed(op, op.detail ?? "The NPC purchase did not settle.");
      } else {
        const create = this.eco.op(`resource-list:${row.sale_id}`);
        if (!create) this.ensureCreate(row);
        else if (create.status === "failed" && this.finalFailure(create)) this.onFailed(create, create.detail ?? "The escrow did not settle.");
        else if (create.status === "settled") {
          const cancelId = this.cancelOpId(row);
          const cancel = cancelId ? this.eco.op(cancelId) : null;
          if (!cancel) this.ensureCancel(row.sale_id);
          else if (cancel.status === "settled") this.onSettled(cancel);
          else if (cancel.status === "failed" && this.finalFailure(cancel)) this.onFailed(cancel, cancel.detail ?? "The withdrawal did not settle.");
          const fillId = this.fillOpId(row);
          const fill = fillId ? this.eco.op(fillId) : null;
          if (fill?.status === "settled") this.onSettled(fill);
          else if (fill?.status === "failed" && this.finalFailure(fill)) this.onFailed(fill, fill.detail ?? "The NPC purchase did not settle.");
        }
      }
    }
  }

  private async decide(row: ResourceSaleRow): Promise<{ buyer: { id: string; accountId: string; totalCc: number } | null; reason: string }> {
    const item = row.item_id;
    const candidates = town.townConfig.MERCHANTS.filter((merchant) => merchant.items.some((offer) => offer.item === item && offer.buys));
    if (!candidates.length) return { buyer: null, reason: `No Vesper merchant is currently configured to buy ${ITEMS[item].name.toLowerCase()}.` };
    const pendingTown = this.db.prepare("SELECT 1 FROM chain_ops WHERE kind = 'batch' AND subject IN ('town','town-open-batch') AND status IN ('created','submitted','failed') LIMIT 1").get();
    if (this.eco.live && pendingTown) return { buyer: null, reason: "The market is reconciling its current books. Your offer stays open while that finishes." };
    const alternatives: string[] = [];
    const state = this.tsvc.state;
    for (const merchant of candidates) {
      const id = merchant.merchantId;
      const cfg = merchant.items.find((offer) => offer.item === item && offer.buys)!;
      const merchantState = state.merchants[id];
      if (!merchantState.open) {
        alternatives.push(`${merchant.person}: closed.`);
        continue;
      }
      const stock = town.tbal(state, item, town.MACC(id));
      const warehouse = Math.max(0, cfg.target * town.townConfig.WAREHOUSE_FULL_X - stock);
      if (warehouse < row.quantity) {
        alternatives.push(`${merchant.person}: only ${warehouse.toLocaleString("en-US")} ${ITEMS[item].units} of warehouse room.`);
        continue;
      }
      const bid = town.tradePrice(state, id, item, "sell", row.quantity);
      if (row.unit_price_cc > bid.unitCc) {
        alternatives.push(`${merchant.person}: current bid is ${cash(bid.unitCc)} per unit; your ask is ${cash(row.unit_price_cc)}.`);
        continue;
      }
      const totalCc = row.unit_price_cc * row.quantity;
      const localCash = town.tbal(state, "cc", town.MACC(id));
      const spendable = Math.max(0, localCash - merchant.fixedCcPerDay);
      if (spendable < totalCc) {
        alternatives.push(`${merchant.person}: has ${cash(localCash)} and keeps ${cash(merchant.fixedCcPerDay)} for daily costs.`);
        continue;
      }
      const npcAccount = this.eco.cfg.npcs[merchant.chainName]?.accountId;
      if (this.eco.live) {
        if (!npcAccount) {
          alternatives.push(`${merchant.person}: cannot verify its market account right now.`);
          continue;
        }
        const chainCash = await this.eco.onChainTokenBalance(npcAccount, "credit:vesper");
        if (chainCash === null) return { buyer: null, reason: "The Market can't confirm the merchant's funds yet. Your offer stays open." };
        if (chainCash < totalCc) {
          alternatives.push(`${merchant.person}: its available buying balance is below ${cash(totalCc)}.`);
          continue;
        }
      }
      return { buyer: { id, accountId: npcAccount ?? "", totalCc }, reason: `${merchant.person} accepts ${row.quantity.toLocaleString("en-US")} ${ITEMS[item].units} at ${cash(row.unit_price_cc)} each: below its ${cash(bid.unitCc)} market bid, within stock room, and within its cash reserve.` };
    }
    return { buyer: null, reason: alternatives.slice(0, 3).join(" ") || "The NPC merchants are waiting for a better fit between price, stock and cash." };
  }

  private beginPurchase(row: ResourceSaleRow, buyer: { id: string; accountId: string; totalCc: number }, reason: string): void {
    // One operator-signed player listing fill at a time prevents two accepted offers from spending the same merchant float.
    if (this.db.prepare("SELECT 1 FROM resource_sales WHERE status = 'buying' LIMIT 1").get()) return;
    const updated = this.db.prepare("UPDATE resource_sales SET status = 'buying', buyer_id = ?, fill_attempt = fill_attempt + 1, detail = ?, updated_at = ? WHERE sale_id = ? AND status = 'listed'")
      .run(buyer.id, reason, nowIso(), row.sale_id);
    if (updated.changes !== 1) return;
    const buying = this.sale(row.sale_id)!;
    const fillId = this.fillOpId(buying)!;
    try {
      this.tsvc.reserveResourceListingCash(row.sale_id, buyer.id, buyer.totalCc);
    } catch (e) {
      this.setStatus(row.sale_id, "listed", `The offer remains open: ${(e as Error).message}`);
      return;
    }
    if (!this.eco.live) {
      try {
        this.tsvc.settleResourceListing(this.trader(buying), this.region(buying), this.rsvc, this.settlement(buying, buyer.id));
        this.setStatus(row.sale_id, "sold", `${reason} Sale complete; ${cash(buyer.totalCc)} added to your balance.`, buyer.id);
      } catch (e) {
        this.tsvc.releaseResourceListingCash(row.sale_id, buyer.id, buyer.totalCc);
        this.setStatus(row.sale_id, "listed", `The offer remains open: ${(e as Error).message}`);
      }
      return;
    }
    this.eco.enqueue({
      opId: fillId,
      kind: "market",
      subject: this.subject(row),
      signer: "operator",
      method: "resource_listing_fill",
      args: { listing_id: row.sale_id, buyer_id: buyer.accountId },
    });
  }

  private ensurePurchaseOperation(row: ResourceSaleRow): void {
    const fillId = this.fillOpId(row);
    if (!this.eco.live || row.status !== "buying" || !fillId || this.eco.op(fillId)) return;
    const buyer = row.buyer_id ? town.townConfig.MERCHANTS.find((m) => m.merchantId === row.buyer_id) : null;
    const account = buyer ? this.eco.cfg.npcs[buyer.chainName]?.accountId : null;
    if (!buyer || !account) {
      this.tsvc.releaseResourceListingCash(row.sale_id, row.buyer_id ?? "", row.quantity * row.unit_price_cc);
      this.setStatus(row.sale_id, "listed", "The merchant could not be verified; the resources remain listed.");
      return;
    }
    const totalCc = row.quantity * row.unit_price_cc;
    try {
      if (!this.tsvc.hasResourceListingCash(row.sale_id, totalCc)) this.tsvc.reserveResourceListingCash(row.sale_id, buyer.merchantId, totalCc);
    } catch (e) {
      this.setStatus(row.sale_id, "listed", `The offer remains open: ${(e as Error).message}`);
      return;
    }
    this.eco.enqueue({ opId: fillId, kind: "market", subject: this.subject(row), signer: "operator", method: "resource_listing_fill", args: { listing_id: row.sale_id, buyer_id: account } });
  }

  private onSettled(row: OpRow): void {
    const saleId = this.saleIdFrom(row);
    if (!saleId) return;
    const sale = this.sale(saleId);
    if (!sale) return;
    if (row.method === "resource_listing_create") {
      if (sale.status === "listing") this.setStatus(saleId, "listed", "Escrow is active. NPC merchants are evaluating your ask against current demand, stock and cash.");
      if (sale.status === "cancelling") this.ensureCancel(saleId);
    } else if (row.method === "resource_listing_cancel") {
      if (sale.status === "cancelling") {
        this.restoreInventory(sale, "The listing was withdrawn. Your resources are back in inventory.");
        this.setStatus(saleId, "cancelled", "Withdrawn. The resources are back in your inventory.");
      }
    } else if (row.method === "resource_listing_fill") {
      if (sale.status === "buying" || sale.status === "cancelling") this.completePurchase(sale);
    }
  }

  private onFailed(row: OpRow, detail: string): void {
    const saleId = this.saleIdFrom(row);
    if (!saleId) return;
    const sale = this.sale(saleId);
    if (!sale) return;
    if (row.method === "resource_listing_create") {
      if (sale.status === "listing" || sale.status === "cancelling") {
        this.restoreInventory(sale, "The offer could not be opened. Your resources are back in inventory.");
        this.setStatus(saleId, "failed", "The offer could not be opened. Your resources are back in inventory.");
      }
    } else if (row.method === "resource_listing_cancel") {
      if (sale.status === "cancelling") {
        this.setStatus(saleId, "listed", "The withdrawal did not complete. The offer remains open; you can try again.", null);
      }
    } else if (row.method === "resource_listing_fill" && sale.status === "buying") {
      const buyer = sale.buyer_id;
      const total = sale.quantity * sale.unit_price_cc;
      if (buyer) this.tsvc.releaseResourceListingCash(saleId, buyer, total);
      this.setStatus(saleId, "listed", this.playerSafeFailure(detail), null);
    } else if (row.method === "resource_listing_fill" && sale.status === "cancelling") {
      const buyer = sale.buyer_id;
      if (buyer) this.tsvc.releaseResourceListingCash(saleId, buyer, sale.quantity * sale.unit_price_cc);
      this.ensureCancel(saleId);
    }
  }

  private completePurchase(row: ResourceSaleRow): void {
    if (row.status === "sold") return;
    if (!row.buyer_id) return;
    const totalCc = row.quantity * row.unit_price_cc;
    const reason = row.detail ?? "An NPC merchant accepted your offer.";
    this.tsvc.settleResourceListing(this.trader(row), this.region(row), this.rsvc, this.settlement(row, row.buyer_id));
    this.setStatus(row.sale_id, "sold", `${reason} Sale complete; ${cash(totalCc)} added to your balance.`, row.buyer_id);
  }

  private restoreInventory(row: ResourceSaleRow, reason: string): void {
    if (row.status === "cancelled" || row.status === "failed") return;
    const h = this.region(row);
    const result = this.rsvc.act(h, {
      type: "TOWN_SETTLE",
      ref: `resource-refund:${row.sale_id}`,
      reason,
      items: { [row.item_id]: row.quantity },
    }, `resource-refund:${row.sale_id}`, "system");
    if (!result.ok) throw new ApiError("INTERNAL", `The market could not restore ${ITEMS[row.item_id].name.toLowerCase()}: ${result.error?.message ?? "unknown error"}`);
  }

  private settlement(row: ResourceSaleRow, merchantId: string) {
    return { listingId: row.sale_id, merchantId, item: row.item_id, quantity: row.quantity, unitPriceCc: row.unit_price_cc, totalCc: row.quantity * row.unit_price_cc };
  }

  private trader(row: ResourceSaleRow): Trader {
    return { userId: row.seller_id, name: this.rsvc.nameOf(row.seller_id) };
  }

  private region(row: ResourceSaleRow): RegionHandle {
    return this.rsvc.get(row.seller_region) ?? this.rsvc.liveFor(row.seller_id);
  }

  private sale(saleId: string): ResourceSaleRow | null {
    return (this.db.prepare("SELECT * FROM resource_sales WHERE sale_id = ?").get(saleId) as ResourceSaleRow | undefined) ?? null;
  }

  private subject(row: ResourceSaleRow): string {
    return `resource-sale:${row.seller_id}:${row.sale_id}`;
  }

  private saleIdFrom(row: OpRow): string | null {
    if (!row.subject?.startsWith("resource-sale:")) return null;
    return row.subject.split(":").at(-1) ?? null;
  }

  private fillOpId(row: ResourceSaleRow): string | null {
    return row.fill_attempt > 0 ? `resource-fill:${row.sale_id}:${row.fill_attempt}` : null;
  }

  private cancelOpId(row: ResourceSaleRow): string | null {
    return row.cancel_attempt > 0 ? `resource-cancel:${row.sale_id}:${row.cancel_attempt}` : null;
  }

  private setStatus(saleId: string, status: ResourceSaleStatus, detail: string, buyer?: string | null): void {
    this.db.prepare(`UPDATE resource_sales SET status = ?, detail = ?, ${buyer !== undefined ? "buyer_id = ?," : ""} updated_at = ? WHERE sale_id = ?`)
      .run(...([status, detail.slice(0, 500), ...(buyer !== undefined ? [buyer] : []), nowIso(), saleId] as (string | null)[]));
  }

  private toView(row: ResourceSaleRow, viewer: string | null): ResourceSaleView {
    const buyer = row.buyer_id ? town.merchantConfig(row.buyer_id) : null;
    return {
      saleId: row.sale_id,
      sellerName: this.rsvc.nameOf(row.seller_id),
      mine: viewer === row.seller_id,
      item: row.item_id,
      quantity: row.quantity,
      unitPriceCc: row.unit_price_cc,
      totalCc: row.quantity * row.unit_price_cc,
      status: row.status,
      buyerName: buyer?.person ?? null,
      decision: row.detail ?? (row.status === "listed" ? "Waiting for an NPC to review the offer." : ""),
      createdAt: row.created_at,
    };
  }

  private finalFailure(op: OpRow): boolean {
    return op.attempts >= 8 || op.attempts >= 99 || (!!op.detail && !TRANSIENT.test(op.detail) && !/Insufficient|exhausted|nonce|Expired|allowance/i.test(op.detail));
  }

  private playerSafeFailure(detail: string): string {
    if (/Insufficient|balance|float|fund/i.test(detail)) return "The merchant's available cash changed before the purchase settled. Your offer is still open.";
    if (/Unknown listing|not active|already/i.test(detail)) return "The market state changed before the purchase settled. Your offer is still open.";
    return "The NPC purchase did not settle. Your resources remain in the listing; an NPC can review it again.";
  }
}

export function startResourceMarketDriver(market: ResourceMarket, ms = 5_000): () => void {
  const timer = setInterval(() => {
    void market.tick().catch((error) => console.error("resource market", error));
  }, ms);
  return () => clearInterval(timer);
}
