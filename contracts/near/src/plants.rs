//! Plant Assets (NEP-171) and settlement epochs.
//!
//! Plant Assets
//!   * Every power plant in BLACKOUT is one NEP-171 token, id `p00042`, minted by the game operator.
//!   * Each token has its own account, `p00042.<this contract>`, created keyless at mint: nobody holds a key to it,
//!     so nobody can sign for it. Its NEP-245 balances (earnings in `credit:vesper`, fuel) live in this contract and
//!     move only through `plant_withdraw`, which the contract allows for the token's CURRENT owner only. Control
//!     therefore transfers with ownership, and the account keeps its balances and its history (events).
//!   * Whole-asset sales: the owner lists a price in `credit:vesper`; `plant_buy` moves the buyer's credits to the
//!     seller and the token to the buyer in one call (both ledgers live here, so it is atomic). Any transfer cancels
//!     the listing and clears approvals.
//!   * The operator may act for player ids in its namespace that have not taken self-custody (same rule as the
//!     exchange). It can never move a released player's plant or anyone else's.
//!
//! Settlement epochs
//!   * `settle_epoch` applies one epoch of net credit movements from the off-chain simulation. Each epoch id is
//!     single-use, the deltas must sum to zero, and debits are allowed only from accounts that consented to the
//!     game's custody: the operator itself, player ids in its namespace (not released), registered NPCs and
//!     traders, and plant accounts. The epoch hash is stored for anyone to compare with the game's Verify screen.
use crate::*;
use near_sdk::json_types::I64;
use near_sdk::{Promise, NearToken};

pub const PLANT_ACCOUNT_DEPOSIT: NearToken = NearToken::from_millinear(5);
/// NEAR the contract keeps free (beyond what its storage locks) before it will pay for a plant account itself.
pub const PLANT_RESERVE: NearToken = NearToken::from_millinear(200);
pub const CREDIT: &str = "credit:vesper";

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PlantMetadata {
    pub title: String,
    pub tech: String,
    pub node_id: String,
    pub capacity_kw: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PlantAsset {
    pub token_id: String,
    pub owner_id: AccountId,
    pub plant_account: AccountId,
    pub metadata: PlantMetadata,
    pub approvals: std::collections::HashMap<AccountId, u64>,
    pub minted_at: u64,
}

/// NEP-171 Token view.
#[near(serializers = [json])]
pub struct JsonToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: serde_json::Value,
    pub approved_account_ids: std::collections::HashMap<AccountId, u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PlantSale {
    pub token_id: String,
    pub seller_id: AccountId,
    pub price: U128,
    pub listed_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct EpochRecord {
    pub epoch_id: String,
    pub hash: String,
    pub accounts: u32,
    pub block_height: u64,
}

fn nft_event(event: &str, data: serde_json::Value) {
    let ev = serde_json::json!({ "standard": "nep171", "version": "1.2.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{}", ev));
}

/// `p00042`, or region-scoped `p<region hash><asset no>` (lowercase letters and digits, at most 24 characters), so the
/// id is also a valid prefix for the plant's own account.
fn valid_plant_id(id: &str) -> bool {
    id.len() >= 6 && id.len() <= 24 && id.starts_with('p') && id[1..].chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

#[near]
impl Contract {
    // ------------------------------------------------------------------ views

    pub fn plant_account_id(&self, token_id: String) -> AccountId {
        require!(valid_plant_id(&token_id), "Plant ids look like p00042");
        format!("{}.{}", token_id, env::current_account_id()).parse().unwrap()
    }

    pub fn nft_metadata(&self) -> serde_json::Value {
        serde_json::json!({ "spec": "nft-1.0.0", "name": "BLACKOUT Plant Assets", "symbol": "PLANT", "icon": null, "base_uri": null, "reference": null, "reference_hash": null })
    }

    pub fn nft_token(&self, token_id: String) -> Option<JsonToken> {
        self.plants.get(&token_id).map(|p| self.json_token(p))
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.plant_count as u128)
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.plants_by_owner.get(&account_id).map(|v| v.len()).unwrap_or(0) as u128)
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let ids = self.plants_by_owner.get(&account_id).cloned().unwrap_or_default();
        let from = from_index.map(|x| x.0 as usize).unwrap_or(0);
        let lim = limit.unwrap_or(50).min(100) as usize;
        ids.iter().skip(from).take(lim).filter_map(|id| self.plants.get(id)).map(|p| self.json_token(p)).collect()
    }

    pub fn plant_sale(&self, token_id: String) -> Option<PlantSale> {
        self.plant_sales.get(&token_id).cloned()
    }

    /// A settled epoch. Batches settled since storage pruning keep only a marker: their hash is in the event log.
    pub fn epoch(&self, epoch_id: String) -> Option<EpochRecord> {
        if let Some(e) = self.epochs.get(&epoch_id) {
            return Some(e.clone());
        }
        env::storage_has_key(&super::economy::settled_key(&epoch_id)).then(|| EpochRecord { epoch_id, hash: "see the settle_batch event".into(), accounts: 0, block_height: 0 })
    }

    pub fn nft_is_approved(&self, token_id: String, approved_account_id: AccountId, approval_id: Option<u64>) -> bool {
        match self.plants.get(&token_id).and_then(|p| p.approvals.get(&approved_account_id).copied()) {
            None => false,
            Some(id) => approval_id.map(|a| a == id).unwrap_or(true),
        }
    }

    // ------------------------------------------------------------------ mint

    /// Operator mints a Plant Asset and creates its keyless plant account. Attach PLANT_ACCOUNT_DEPOSIT.
    #[payable]
    pub fn plant_mint(&mut self, token_id: String, owner_id: AccountId, metadata: PlantMetadata) -> Promise {
        self.assert_operator();
        require!(valid_plant_id(&token_id), "Plant ids look like p00042");
        require!(self.plants.get(&token_id).is_none(), "Plant already minted");
        // the operator's function-call key can't attach a deposit, so the contract may pay for the plant account from
        // its own balance, but only while it keeps a reserve for its storage
        let deposit = if env::attached_deposit() >= PLANT_ACCOUNT_DEPOSIT { env::attached_deposit() } else { PLANT_ACCOUNT_DEPOSIT };
        let locked = env::storage_byte_cost().as_yoctonear().saturating_mul(env::storage_usage() as u128);
        let free = env::account_balance().as_yoctonear().saturating_sub(locked);
        require!(
            env::attached_deposit() >= PLANT_ACCOUNT_DEPOSIT || free > PLANT_RESERVE.as_yoctonear() + PLANT_ACCOUNT_DEPOSIT.as_yoctonear(),
            "Attach 0.005 NEAR for the plant account (the contract's own reserve is too low)"
        );
        require!(metadata.title.len() <= 80 && metadata.tech.len() <= 16 && metadata.node_id.len() <= 32, "Metadata too long");
        let plant_account = self.plant_account_id(token_id.clone());
        let asset = PlantAsset { token_id: token_id.clone(), owner_id: owner_id.clone(), plant_account: plant_account.clone(), metadata, approvals: Default::default(), minted_at: env::block_height() };
        self.plants.insert(token_id.clone(), asset);
        self.index_add(&owner_id, &token_id);
        self.plant_count += 1;
        // the plant account can hold game tokens from the start
        self.registered.insert(plant_account.clone());
        nft_event("nft_mint", serde_json::json!({ "owner_id": owner_id, "token_ids": [token_id], "memo": format!("plant account {}", plant_account) }));
        // keyless: no access key is ever added, so only this contract can direct the account's game balances
        Promise::new(plant_account).create_account().transfer(deposit)
    }

    // ------------------------------------------------------------------ NEP-171 core

    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        let p = self.plants.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such plant"));
        if sender != p.owner_id {
            let a = p.approvals.get(&sender).copied().unwrap_or_else(|| env::panic_str("Not the owner or an approved account"));
            if let Some(id) = approval_id {
                require!(id == a, "Approval id mismatch");
            }
        }
        self.internal_plant_transfer(&token_id, &receiver_id, Some(&sender), memo);
    }

    #[payable]
    pub fn nft_approve(&mut self, token_id: String, account_id: AccountId) {
        assert_one_yocto();
        let mut p = self.plants.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such plant"));
        require!(env::predecessor_account_id() == p.owner_id, "Only the owner can approve");
        self.next_approval_id += 1;
        p.approvals.insert(account_id, self.next_approval_id);
        self.plants.insert(token_id, p);
    }

    #[payable]
    pub fn nft_revoke(&mut self, token_id: String, account_id: AccountId) {
        assert_one_yocto();
        let mut p = self.plants.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such plant"));
        require!(env::predecessor_account_id() == p.owner_id, "Only the owner can revoke");
        p.approvals.remove(&account_id);
        self.plants.insert(token_id, p);
    }

    /// Operator moves a namespaced (not released) player's plant, e.g. a sale between players agreed in game.
    pub fn plant_transfer_for(&mut self, owner_id: AccountId, receiver_id: AccountId, token_id: String) {
        self.assert_operator();
        self.assert_player_id(&owner_id);
        let p = self.plants.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such plant"));
        require!(p.owner_id == owner_id, "That player doesn't own this plant");
        let op = env::predecessor_account_id();
        self.internal_plant_transfer(&token_id, &receiver_id, Some(&op), Some("operator transfer".into()));
    }

    // ------------------------------------------------------------------ plant account control

    /// Moves NEP-245 tokens out of the plant's account to its CURRENT owner. Only that owner (or the operator for a
    /// namespaced, unreleased owner) may call it: whoever owns the token controls the account.
    pub fn plant_withdraw(&mut self, token_id: String, mt_token_id: TokenId, amount: U128) {
        let p = self.plants.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such plant"));
        self.assert_controls(&p.owner_id);
        self.internal_move(&p.plant_account, &p.owner_id, &mt_token_id, amount.0);
        emit("mt_transfer", serde_json::json!({ "authorized_id": env::predecessor_account_id(), "old_owner_id": p.plant_account, "new_owner_id": p.owner_id, "token_ids": [mt_token_id], "amounts": [amount], "memo": format!("withdraw from {}", token_id) }));
    }

    // ------------------------------------------------------------------ whole-asset sales

    pub fn plant_list(&mut self, token_id: String, price: U128) {
        let p = self.plants.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such plant"));
        self.assert_controls(&p.owner_id);
        require!(price.0 > 0, "Price must be positive");
        self.plant_sales.insert(token_id.clone(), PlantSale { token_id: token_id.clone(), seller_id: p.owner_id.clone(), price, listed_at: env::block_height() });
        nft_event("plant_listed", serde_json::json!({ "token_id": token_id, "seller_id": p.owner_id, "price": price }));
    }

    pub fn plant_cancel_listing(&mut self, token_id: String) {
        let p = self.plants.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("No such plant"));
        self.assert_controls(&p.owner_id);
        require!(self.plant_sales.remove(&token_id).is_some(), "Not listed");
    }

    /// The caller buys a listed plant: credits to the seller, token (and its account) to the caller, atomically.
    pub fn plant_buy(&mut self, token_id: String) {
        let buyer = env::predecessor_account_id();
        self.internal_buy(&token_id, &buyer);
    }

    /// Operator buys for a namespaced (not released) player.
    pub fn plant_buy_for(&mut self, buyer_id: AccountId, token_id: String) {
        self.assert_operator();
        self.assert_player_id(&buyer_id);
        self.internal_buy(&token_id, &buyer_id);
    }

    // ------------------------------------------------------------------ settlement

    /// Applies one settlement epoch of net `credit:vesper` movements. Single-use id, zero-sum, consented debits only.
    pub fn settle_epoch(&mut self, epoch_id: String, hash: String, deltas: Vec<(AccountId, I64)>) {
        self.internal_settle(epoch_id, hash, CREDIT.to_string(), deltas);
    }

    /// The same for any registered item token (fuel, permits, certificates, steel, parts): one call per token per
    /// epoch, keyed `<epoch_id>|<token_id>`, so a market epoch moving six items settles in six single-use calls.
    pub fn settle_items(&mut self, epoch_id: String, hash: String, token_id: TokenId, deltas: Vec<(AccountId, I64)>) {
        let key = format!("{}|{}", epoch_id, token_id);
        self.internal_settle(key, hash, token_id, deltas);
    }

    fn internal_settle(&mut self, epoch_id: String, hash: String, credit: TokenId, deltas: Vec<(AccountId, I64)>) {
        self.assert_operator();
        require!(!epoch_id.is_empty() && epoch_id.len() <= 160, "Bad epoch id");
        require!(hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()), "Hash must be 64 hex characters");
        require!(self.epochs.get(&epoch_id).is_none() && !env::storage_has_key(&super::economy::settled_key(&epoch_id)), "Epoch already settled");
        require!(!deltas.is_empty() && deltas.len() <= 40, "1 to 40 accounts per epoch");
        let sum: i128 = deltas.iter().map(|(_, d)| d.0 as i128).sum();
        require!(sum == 0, "Epoch deltas must sum to zero");
        require!(self.supply.get(&credit).is_some(), "Token is not registered");
        // debits first, so a short account fails the whole epoch before anything moves
        self.apply_deltas(&credit, &deltas);
        self.epochs.insert(epoch_id.clone(), EpochRecord { epoch_id: epoch_id.clone(), hash: hash.clone(), accounts: deltas.len() as u32, block_height: env::block_height() });
        env::log_str(&format!("EVENT_JSON:{}", serde_json::json!({ "standard": "blackout", "version": "1.0.0", "event": "settle_epoch", "data": [{ "epoch_id": epoch_id, "token_id": credit, "hash": hash, "accounts": deltas.len() }] })));
    }

    // ------------------------------------------------------------------ internals

    fn json_token(&self, p: &PlantAsset) -> JsonToken {
        JsonToken {
            token_id: p.token_id.clone(),
            owner_id: p.owner_id.clone(),
            metadata: serde_json::json!({ "title": p.metadata.title, "description": format!("{} kW {} in {}", p.metadata.capacity_kw, p.metadata.tech, p.metadata.node_id), "extra": serde_json::json!({ "plant_account": p.plant_account, "tech": p.metadata.tech, "node_id": p.metadata.node_id, "capacity_kw": p.metadata.capacity_kw }).to_string() }),
            approved_account_ids: p.approvals.clone(),
        }
    }

    fn assert_controls(&self, owner: &AccountId) {
        let caller = env::predecessor_account_id();
        let ok = &caller == owner || (caller == self.operator_id && self.is_player_id(owner));
        require!(ok, "Only the plant's owner controls it");
    }

    pub(crate) fn may_debit(&self, acct: &AccountId) -> bool {
        if acct == &self.operator_id || self.is_player_id(acct) || self.npcs.get(acct).is_some() || self.traders.get(acct).is_some() {
            return true;
        }
        // plant accounts: <p00042>.<this contract>
        let s = acct.as_str();
        let suffix = format!(".{}", env::current_account_id());
        s.ends_with(&suffix) && valid_plant_id(&s[..s.len() - suffix.len()])
    }

    pub(crate) fn internal_settle_move(&mut self, from: &AccountId, to: &AccountId, token: &TokenId, amount: u128) {
        let fk = bkey(token, from);
        let fb = self.balances.get(&fk).copied().unwrap_or(0);
        require!(fb >= amount, "Insufficient credits for this epoch");
        self.balances.insert(fk, fb - amount);
        let tk = bkey(token, to);
        let tb = self.balances.get(&tk).copied().unwrap_or(0);
        self.balances.insert(tk, tb.checked_add(amount).expect("balance overflow"));
    }

    fn internal_buy(&mut self, token_id: &String, buyer: &AccountId) {
        let sale = self.plant_sales.get(token_id).cloned().unwrap_or_else(|| env::panic_str("Not for sale"));
        let p = self.plants.get(token_id).cloned().unwrap_or_else(|| env::panic_str("No such plant"));
        require!(sale.seller_id == p.owner_id, "Stale listing");
        require!(&p.owner_id != buyer, "You already own it");
        let credit_token: TokenId = CREDIT.to_string();
        self.internal_move(buyer, &p.owner_id, &credit_token, sale.price.0);
        emit("mt_transfer", serde_json::json!({ "old_owner_id": buyer, "new_owner_id": p.owner_id, "token_ids": [CREDIT], "amounts": [sale.price], "memo": format!("buy {}", token_id) }));
        self.internal_plant_transfer(token_id, buyer, None, Some(format!("sold for {} credits", sale.price.0)));
    }

    fn internal_plant_transfer(&mut self, token_id: &String, receiver: &AccountId, authorized: Option<&AccountId>, memo: Option<String>) {
        let mut p = self.plants.get(token_id).cloned().unwrap_or_else(|| env::panic_str("No such plant"));
        let old = p.owner_id.clone();
        require!(&old != receiver, "Sender and receiver must differ");
        p.owner_id = receiver.clone();
        p.approvals.clear();
        self.plants.insert(token_id.clone(), p);
        self.index_remove(&old, token_id);
        self.index_add(receiver, token_id);
        self.plant_sales.remove(token_id);
        let auth = authorized.filter(|a| *a != &old).cloned();
        nft_event("nft_transfer", serde_json::json!({ "authorized_id": auth, "old_owner_id": old, "new_owner_id": receiver, "token_ids": [token_id], "memo": memo }));
    }

    fn index_add(&mut self, owner: &AccountId, token_id: &String) {
        let mut v = self.plants_by_owner.get(owner).cloned().unwrap_or_default();
        v.push(token_id.clone());
        self.plants_by_owner.insert(owner.clone(), v);
    }

    fn index_remove(&mut self, owner: &AccountId, token_id: &String) {
        let mut v = self.plants_by_owner.get(owner).cloned().unwrap_or_default();
        v.retain(|x| x != token_id);
        if v.is_empty() {
            self.plants_by_owner.remove(owner);
        } else {
            self.plants_by_owner.insert(owner.clone(), v);
        }
    }
}
