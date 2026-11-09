//! The game economy on chain: a fixed-supply treasury, NPC spending limits, power-delivery escrow and atomic
//! batch settlement.
//!
//! Money (`credit:vesper`, shown in game as ₡; 1 unit = ₡0.01)
//!   * `init_economy` mints the whole supply ONCE to the treasury account and splits it into named buckets with caps
//!     (city budget, NPC starting capital, player starting capital, outside-world trade float, reserve). Before it
//!     runs, the credit supply must be zero; after it runs, `mt_mint` refuses credits for good. The only other way
//!     credits can ever be created is `issue`: owner-only, into a named bucket, and bounded by `issue_cap` for the life
//!     of the contract. Every grant and issue is recorded and emits an event.
//!   * `treasury_grant` pays from the treasury: single-use grant id, inside the bucket's cap and per-grant maximum,
//!     and (for player and NPC starting capital) at most once per receiving account. If a bucket runs dry the grant
//!     fails: nothing is minted to cover it.
//!
//! NPC wallets
//!   * An NPC is a real NEAR account with a function-call key the game server uses on its behalf. Function-call keys
//!     can't attach the 1 yoctoNEAR a normal NEP-245 transfer requires, so NPC spending goes through methods that
//!     check the caller is a registered NPC instead, and every such payment is bounded: a per-payment cap, a daily cap,
//!     a per-NPC pause switch and a global kill switch (owner or operator can pull it).
//!
//! Power-delivery escrow
//!   * Electricity can't live on chain; payment for it can. A buyer (an NPC with its own key, or any account that
//!     attaches 1 yocto) places an order to buy `kwh` from a seller at a price: the full amount moves into escrow.
//!   * The game operator, which runs the grid simulation, confirms how much was actually delivered: the seller is paid
//!     for that, the buyer gets the rest back. Nobody else can confirm; the chain trusts the operator on delivery
//!     (it can't measure electricity) but can never pay out more than the buyer escrowed, and can't touch it twice.
//!   * If nobody confirms, anyone can expire the order after its deadline and the buyer is refunded in full.
//!
//! Batch settlement
//!   * `settle_batch` applies one settlement epoch across several tokens (credits and items) in a single call, so a
//!     market epoch's payments and deliveries land together or not at all.
use super::plants::CREDIT;
use super::*;
use near_sdk::json_types::I64;

const MAX_ID: usize = 128;
const MAX_ORDER_KWH: u64 = 10_000_000;
const MAX_PRICE_PER_MWH: u128 = 10_000_000; // ₡100,000 per MWh
const EXPIRY_GRACE_NS: u64 = 60_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Bucket {
    pub name: String,
    pub cap: U128,
    pub granted: U128,
    /// Largest single grant from this bucket (0 = no per-grant limit).
    pub max_per_grant: U128,
    /// Starting capital: an account can receive from this bucket only once.
    pub once_per_account: bool,
}

#[near(serializers = [json])]
pub struct BucketInput {
    pub name: String,
    pub cap: U128,
    pub max_per_grant: U128,
    pub once_per_account: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct EconomyState {
    pub treasury_id: AccountId,
    /// Players' wallets are sub-accounts of this account; the operator may settle for them until they take self-custody.
    pub player_parent_id: AccountId,
    pub initial_supply: U128,
    pub issued: U128,
    pub issue_cap: U128,
    pub buckets: Vec<Bucket>,
    pub npc_spending_paused: bool,
    pub initialized_at_block: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct GrantRecord {
    pub grant_id: String,
    pub bucket: String,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub memo: String,
    pub block_height: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct NpcLimits {
    pub max_per_payment: U128,
    pub max_per_day: U128,
    pub paused: bool,
    pub day: u64,
    pub spent_today: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PowerOrder {
    pub order_id: String,
    pub buyer_id: AccountId,
    pub seller_id: AccountId,
    pub kwh: u64,
    /// credits (cc) per MWh
    pub price_per_mwh: U128,
    pub escrow: U128,
    /// "open" | "settled" | "expired"
    pub status: String,
    pub delivered_kwh: u64,
    pub paid: U128,
    pub refunded: U128,
    pub memo: String,
    pub expires_at_ns: u64,
    pub opened_at_block: u64,
    pub closed_at_block: u64,
}

fn blackout_event(event: &str, data: serde_json::Value) {
    let ev = serde_json::json!({ "standard": "blackout", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{}", ev));
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID
}

#[near]
impl Contract {
    // ------------------------------------------------------------------ treasury

    /// One-time genesis. Mints `total_supply` credits to the treasury and records the buckets (whose caps must add up
    /// to the supply exactly). Owner only; the credit token must be registered and still have zero supply.
    pub fn init_economy(&mut self, treasury_id: AccountId, player_parent_id: AccountId, total_supply: U128, buckets: Vec<BucketInput>, issue_cap: U128) {
        self.assert_owner();
        require!(self.economy.is_none(), "The economy is already initialised");
        let credit: TokenId = CREDIT.to_string();
        let s = self.supply.get(&credit).copied().unwrap_or_else(|| env::panic_str("Register credit:vesper first"));
        require!(s == 0, "Credits were minted before genesis; redeploy");
        require!(total_supply.0 > 0, "Supply must be positive");
        require!(!buckets.is_empty() && buckets.len() <= 12, "1 to 12 buckets");
        let sum: u128 = buckets.iter().map(|b| b.cap.0).sum();
        require!(sum == total_supply.0, "Bucket caps must add up to the total supply");
        let mut names: Vec<&str> = buckets.iter().map(|b| b.name.as_str()).collect();
        names.sort();
        names.dedup();
        require!(names.len() == buckets.len() && buckets.iter().all(|b| valid_id(&b.name) && b.name.len() <= 32), "Bucket names must be unique and short");
        self.registered.insert(treasury_id.clone());
        self.internal_mint(&treasury_id, &credit, total_supply.0, "genesis: the whole supply, minted once");
        self.economy = Some(EconomyState {
            treasury_id: treasury_id.clone(),
            player_parent_id,
            initial_supply: total_supply,
            issued: U128(0),
            issue_cap,
            buckets: buckets.into_iter().map(|b| Bucket { name: b.name, cap: b.cap, granted: U128(0), max_per_grant: b.max_per_grant, once_per_account: b.once_per_account }).collect(),
            npc_spending_paused: false,
            initialized_at_block: env::block_height(),
        });
        blackout_event("economy_init", serde_json::json!({ "treasury_id": treasury_id, "total_supply": total_supply, "issue_cap": issue_cap }));
    }

    /// Pays `amount` from the treasury out of `bucket`. Operator (or owner) only. Single-use `grant_id`; bounded by the
    /// bucket's cap and per-grant maximum; once per account for starting-capital buckets. Never mints.
    pub fn treasury_grant(&mut self, grant_id: String, bucket: String, receiver_id: AccountId, amount: U128, memo: String) {
        let caller = env::predecessor_account_id();
        require!(caller == self.operator_id || caller == self.owner_id, "Only the game operator");
        require!(valid_id(&grant_id) && memo.len() <= 200, "Bad grant id or memo");
        require!(self.grants.get(&grant_id).is_none(), "Grant already paid");
        require!(amount.0 > 0, "Amount must be positive");
        let mut eco = self.economy.clone().unwrap_or_else(|| env::panic_str("The economy is not initialised"));
        let b = eco.buckets.iter_mut().find(|x| x.name == bucket).unwrap_or_else(|| env::panic_str("No such bucket"));
        require!(b.max_per_grant.0 == 0 || amount.0 <= b.max_per_grant.0, "Above this bucket's per-grant limit");
        require!(b.granted.0 + amount.0 <= b.cap.0, "This treasury bucket is exhausted");
        let once_key = format!("{}|{}", bucket, receiver_id);
        if b.once_per_account {
            require!(self.granted_to.get(&once_key).is_none(), "This account already received its starting capital");
        }
        b.granted = U128(b.granted.0 + amount.0);
        let once = b.once_per_account;
        let treasury = eco.treasury_id.clone();
        self.economy = Some(eco);
        self.registered.insert(receiver_id.clone());
        let credit: TokenId = CREDIT.to_string();
        self.internal_settle_move(&treasury, &receiver_id, &credit, amount.0);
        if once {
            self.granted_to.insert(once_key, grant_id.clone());
        }
        self.grants.insert(grant_id.clone(), GrantRecord { grant_id: grant_id.clone(), bucket: bucket.clone(), receiver_id: receiver_id.clone(), amount, memo: memo.clone(), block_height: env::block_height() });
        emit("mt_transfer", serde_json::json!({ "old_owner_id": treasury, "new_owner_id": receiver_id, "token_ids": [CREDIT], "amounts": [amount], "memo": format!("{}: {}", bucket, memo) }));
        blackout_event("treasury_grant", serde_json::json!({ "grant_id": grant_id, "bucket": bucket, "receiver_id": receiver_id, "amount": amount }));
    }

    /// The only way to create credits after genesis: owner only, into a named bucket, bounded by `issue_cap` in total.
    pub fn issue(&mut self, bucket: String, amount: U128, reason: String) {
        self.assert_owner();
        require!(amount.0 > 0 && reason.len() >= 4 && reason.len() <= 200, "Give an amount and a reason");
        let mut eco = self.economy.clone().unwrap_or_else(|| env::panic_str("The economy is not initialised"));
        require!(eco.issued.0 + amount.0 <= eco.issue_cap.0, "Above the lifetime issuance cap");
        let b = eco.buckets.iter_mut().find(|x| x.name == bucket).unwrap_or_else(|| env::panic_str("No such bucket"));
        b.cap = U128(b.cap.0 + amount.0);
        eco.issued = U128(eco.issued.0 + amount.0);
        let treasury = eco.treasury_id.clone();
        self.economy = Some(eco);
        let credit: TokenId = CREDIT.to_string();
        self.internal_mint(&treasury, &credit, amount.0, &format!("issue into {}: {}", bucket, reason));
        blackout_event("issue", serde_json::json!({ "bucket": bucket, "amount": amount, "reason": reason }));
    }

    pub fn economy_info(&self) -> serde_json::Value {
        let credit: TokenId = CREDIT.to_string();
        match &self.economy {
            None => serde_json::json!({ "initialized": false }),
            Some(e) => serde_json::json!({
                "initialized": true,
                "treasury_id": e.treasury_id,
                "player_parent_id": e.player_parent_id,
                "initial_supply": e.initial_supply,
                "issued": e.issued,
                "issue_cap": e.issue_cap,
                "total_supply": U128(self.supply.get(&credit).copied().unwrap_or(0)),
                "treasury_balance": U128(self.balances.get(&bkey(&credit, &e.treasury_id)).copied().unwrap_or(0)),
                "buckets": e.buckets,
                "npc_spending_paused": e.npc_spending_paused,
            }),
        }
    }

    pub fn grant(&self, grant_id: String) -> Option<GrantRecord> {
        self.grants.get(&grant_id).cloned()
    }

    /// The grant id an account received from a once-per-account bucket, if any.
    pub fn granted(&self, bucket: String, account_id: AccountId) -> Option<String> {
        self.granted_to.get(&format!("{}|{}", bucket, account_id)).cloned()
    }

    // ------------------------------------------------------------------ NPC limits and kill switches

    pub fn set_npc_limits(&mut self, account_id: AccountId, max_per_payment: U128, max_per_day: U128) {
        self.assert_owner();
        require!(self.npcs.get(&account_id).is_some(), "Register the NPC first");
        let prev = self.npc_limits.get(&account_id).cloned();
        self.npc_limits.insert(account_id, NpcLimits { max_per_payment, max_per_day, paused: prev.as_ref().map(|p| p.paused).unwrap_or(false), day: prev.as_ref().map(|p| p.day).unwrap_or(0), spent_today: prev.map(|p| p.spent_today).unwrap_or(U128(0)) });
    }

    /// Emergency stop for one NPC's spending (owner or operator).
    pub fn set_npc_paused(&mut self, account_id: AccountId, paused: bool) {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_id || caller == self.operator_id, "Only the owner or operator");
        let mut l = self.npc_limits.get(&account_id).cloned().unwrap_or_else(|| env::panic_str("No limits set for this NPC"));
        l.paused = paused;
        self.npc_limits.insert(account_id.clone(), l);
        blackout_event("npc_paused", serde_json::json!({ "account_id": account_id, "paused": paused }));
    }

    /// Global kill switch for every NPC's spending (owner or operator).
    pub fn set_npc_spending_paused(&mut self, paused: bool) {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_id || caller == self.operator_id, "Only the owner or operator");
        let mut e = self.economy.clone().unwrap_or_else(|| env::panic_str("The economy is not initialised"));
        e.npc_spending_paused = paused;
        self.economy = Some(e);
        blackout_event("npc_spending_paused", serde_json::json!({ "paused": paused }));
    }

    pub fn npc_limits(&self, account_id: AccountId) -> Option<NpcLimits> {
        self.npc_limits.get(&account_id).cloned()
    }

    // ------------------------------------------------------------------ power-delivery escrow

    /// The buyer escrows payment for `kwh` from `seller_id` at `price_per_mwh` credits. A registered NPC calls it with
    /// its function-call key (no deposit; its limits apply); anyone else attaches exactly 1 yoctoNEAR.
    #[payable]
    pub fn power_order_place(&mut self, order_id: String, seller_id: AccountId, kwh: u64, price_per_mwh: U128, expires_in_minutes: u32, memo: String) {
        let buyer = env::predecessor_account_id();
        require!(valid_id(&order_id) && memo.len() <= 280, "Bad order id or memo");
        require!(self.power_orders.get(&order_id).is_none(), "Order id already used");
        require!(buyer != seller_id, "Buyer and seller must differ");
        require!(kwh > 0 && kwh <= MAX_ORDER_KWH, "kWh out of range");
        require!(price_per_mwh.0 > 0 && price_per_mwh.0 <= MAX_PRICE_PER_MWH, "Price out of range");
        require!(expires_in_minutes >= 1 && expires_in_minutes <= 1440, "Expiry must be 1 minute to 1 day");
        let escrow = ((kwh as u128) * price_per_mwh.0 + 999) / 1000;
        if self.npcs.get(&buyer).is_some() {
            self.charge_npc(&buyer, escrow);
        } else {
            assert_one_yocto();
        }
        let credit: TokenId = CREDIT.to_string();
        let pool = env::current_account_id();
        self.internal_settle_move(&buyer, &pool, &credit, escrow);
        self.registered.insert(seller_id.clone());
        let expires_at_ns = env::block_timestamp() + (expires_in_minutes as u64) * 60_000_000_000;
        self.power_orders.insert(
            order_id.clone(),
            PowerOrder { order_id: order_id.clone(), buyer_id: buyer.clone(), seller_id: seller_id.clone(), kwh, price_per_mwh, escrow: U128(escrow), status: "open".into(), delivered_kwh: 0, paid: U128(0), refunded: U128(0), memo: memo.clone(), expires_at_ns, opened_at_block: env::block_height(), closed_at_block: 0 },
        );
        blackout_event("power_order_placed", serde_json::json!({ "order_id": order_id, "buyer_id": buyer, "seller_id": seller_id, "kwh": kwh, "price_per_mwh": price_per_mwh, "escrow": U128(escrow), "memo": memo }));
    }

    /// The grid operator reports delivery: the seller is paid for what was delivered, the buyer gets the rest back.
    pub fn power_order_confirm(&mut self, order_id: String, delivered_kwh: u64) {
        require!(env::predecessor_account_id() == self.operator_id, "Only the grid operator confirms delivery");
        let mut o = self.power_orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("No such order"));
        require!(o.status == "open", "Order already closed");
        require!(delivered_kwh <= o.kwh, "Delivered more than ordered");
        let pay = ((delivered_kwh as u128) * o.price_per_mwh.0 / 1000).min(o.escrow.0);
        let refund = o.escrow.0 - pay;
        let credit: TokenId = CREDIT.to_string();
        let pool = env::current_account_id();
        if pay > 0 {
            self.internal_settle_move(&pool, &o.seller_id, &credit, pay);
        }
        if refund > 0 {
            self.internal_settle_move(&pool, &o.buyer_id, &credit, refund);
        }
        o.status = "settled".into();
        o.delivered_kwh = delivered_kwh;
        o.paid = U128(pay);
        o.refunded = U128(refund);
        o.closed_at_block = env::block_height();
        self.power_orders.insert(order_id.clone(), o.clone());
        emit("mt_transfer", serde_json::json!({ "old_owner_id": o.buyer_id, "new_owner_id": o.seller_id, "token_ids": [CREDIT], "amounts": [U128(pay)], "memo": format!("power {} kWh, order {}", delivered_kwh, order_id) }));
        blackout_event("power_order_settled", serde_json::json!({ "order_id": order_id, "delivered_kwh": delivered_kwh, "paid": U128(pay), "refunded": U128(refund) }));
    }

    /// After the deadline (plus a minute's grace) anyone can close an unconfirmed order: the buyer is refunded in full.
    pub fn power_order_expire(&mut self, order_id: String) {
        let mut o = self.power_orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("No such order"));
        require!(o.status == "open", "Order already closed");
        require!(env::block_timestamp() > o.expires_at_ns + EXPIRY_GRACE_NS, "Not expired yet");
        let credit: TokenId = CREDIT.to_string();
        let pool = env::current_account_id();
        self.internal_settle_move(&pool, &o.buyer_id, &credit, o.escrow.0);
        o.status = "expired".into();
        o.refunded = o.escrow;
        o.closed_at_block = env::block_height();
        self.power_orders.insert(order_id.clone(), o);
        blackout_event("power_order_expired", serde_json::json!({ "order_id": order_id }));
    }

    pub fn power_order(&self, order_id: String) -> Option<PowerOrder> {
        self.power_orders.get(&order_id).cloned()
    }

    // ------------------------------------------------------------------ atomic batch settlement

    /// One settlement epoch across several tokens, all or nothing. Same rules as `settle_epoch` for each token.
    pub fn settle_batch(&mut self, epoch_id: String, hash: String, entries: Vec<(TokenId, Vec<(AccountId, I64)>)>) {
        self.assert_operator();
        require!(!epoch_id.is_empty() && epoch_id.len() <= 160, "Bad epoch id");
        require!(hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()), "Hash must be 64 hex characters");
        require!(self.epochs.get(&epoch_id).is_none(), "Epoch already settled");
        require!(!entries.is_empty() && entries.len() <= 10, "1 to 10 tokens per batch");
        let mut accounts = 0u32;
        for (token, deltas) in entries.iter() {
            self.apply_deltas(token, deltas);
            accounts += deltas.len() as u32;
        }
        self.epochs.insert(epoch_id.clone(), plants::EpochRecord { epoch_id: epoch_id.clone(), hash: hash.clone(), accounts, block_height: env::block_height() });
        blackout_event("settle_batch", serde_json::json!({ "epoch_id": epoch_id, "hash": hash, "tokens": entries.iter().map(|(t, _)| t.clone()).collect::<Vec<_>>(), "accounts": accounts }));
    }

    // ------------------------------------------------------------------ internals

    /// Zero-sum, consented debits first; used by every settlement path.
    pub(crate) fn apply_deltas(&mut self, token: &TokenId, deltas: &[(AccountId, I64)]) {
        require!(!deltas.is_empty() && deltas.len() <= 40, "1 to 40 accounts per token");
        let sum: i128 = deltas.iter().map(|(_, d)| d.0 as i128).sum();
        require!(sum == 0, "Epoch deltas must sum to zero");
        require!(self.supply.get(token).is_some(), "Token is not registered");
        let pool = env::current_account_id();
        for (acct, d) in deltas.iter().filter(|(_, d)| d.0 < 0) {
            require!(self.may_debit(acct), "Debit from an account that didn't consent to game custody");
            self.internal_settle_move(acct, &pool, token, (-d.0) as u128);
        }
        for (acct, d) in deltas.iter().filter(|(_, d)| d.0 > 0) {
            if !self.registered.contains(acct) {
                self.registered.insert(acct.clone());
            }
            self.internal_settle_move(&pool, acct, token, d.0 as u128);
        }
    }

    fn charge_npc(&mut self, npc: &AccountId, amount: u128) {
        let eco = self.economy.as_ref().unwrap_or_else(|| env::panic_str("The economy is not initialised"));
        require!(!eco.npc_spending_paused, "NPC spending is paused");
        let mut l = self.npc_limits.get(npc).cloned().unwrap_or_else(|| env::panic_str("This NPC has no spending limits set"));
        require!(!l.paused, "This NPC's spending is paused");
        require!(amount <= l.max_per_payment.0, "Above this NPC's per-payment limit");
        let today = env::block_timestamp() / NANOS_PER_DAY;
        if l.day != today {
            l.day = today;
            l.spent_today = U128(0);
        }
        require!(l.spent_today.0 + amount <= l.max_per_day.0, "Above this NPC's daily spending limit");
        l.spent_today = U128(l.spent_today.0 + amount);
        self.npc_limits.insert(npc.clone(), l);
    }
}
