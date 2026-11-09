//! BLACKOUT resources — a NEP-245 multi-token contract.
//!
//! One contract holds every game item type. Token ids and units:
//!   DIESEL_100ML        1 unit = 100 mL of diesel   (decimals 0; 10 units = 1 L)
//!   CARBON_PERMIT_10KG  1 unit = one 10 kg CO2 permit
//!   REPAIR_PART, SOLAR_COMPONENT, BATTERY_COMPONENT   1 unit = one item
//!
//! Standard surface (NEP-245 core): mt_transfer, mt_batch_transfer, mt_transfer_call,
//! mt_batch_transfer_call, mt_resolve_transfer (private), mt_token, mt_balance_of,
//! mt_batch_balance_of, mt_supply, mt_batch_supply; approvals: mt_approve, mt_revoke,
//! mt_is_approved. Events: EVENT_JSON {standard:"nep245", version:"1.0.0"}.
//! Amounts are U128 strings; transfers require exactly 1 yoctoNEAR.
//!
//! Game extensions (documented, not part of NEP-245):
//!   * storage_deposit / storage_balance_of: receivers must be registered (pays storage);
//!   * register_npc + npc_transfer: an NPC merchant account may move ITS OWN tokens
//!     without the 1-yocto deposit so that a FUNCTION-CALL access key (which cannot
//!     attach deposits) can sign it. Bounded by a per-call cap set by the owner and
//!     idempotent per `trade_id` (a replayed trade panics). It can never move anyone
//!     else's tokens.
//!   * custodial_list / custodial_cancel_listing / custodial_fill_listing: an operator-key
//!     escrow path for game-authenticated player listings. Only escrowed resources can fill;
//!     the buyer must be a registered NPC. Credits remain off-chain.
//!   * trade_status(trade_id): lets the game server reconcile an unknown tx outcome.
//!   * Shared fuel exchange (every city trades on one order book):
//!       - player balances live under ids in the operator's namespace (`p<hash>.<operator_id>`).
//!         The operator may mint (exchange_deposit), burn (exchange_redeem), escrow (exchange_ask),
//!         cancel and buy (exchange_fill) ONLY for ids in that namespace. It can never move a
//!         trader's or any external account's tokens.
//!       - registered traders sign their OWN asks, cancels, fills and capped daily imports
//!         (npc_import) with function-call keys (no deposit required).
//!       - every deposit / redeem / fill / import id is single-use; escrowed fuel cannot be
//!         sold twice; partial fills reduce an order's `remaining`. Credits remain off-chain.
//!       - self-custody: once the vault creates the player's namespaced account with the player's
//!         own key, the player can call `release_to_owner` (with no open offers). From then on the
//!         operator can never move that id's tokens again; the player holds them like any account.
//!   * settle_day: the operator burns the diesel it consumed in simulation from its OWN
//!     custody balance and the contract checks the batch is internally consistent
//!     (CO2 = fuel x 2.68 kg/L, permits retired cover the CO2). It cannot verify
//!     that electricity was actually produced; the game server is trusted for that.

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, serde_json, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    PromiseOrValue,
};
use std::collections::HashMap;

pub type TokenId = String;

pub const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10); // 0.01 NEAR per registered account
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_TRANSFER: Gas = Gas::from_tgas(25);
/// 100 mL of diesel emits 268 g CO2 (2.68 kg per litre).
pub const CO2_G_PER_DIESEL_UNIT: u128 = 268;
pub const PERMIT_G: u128 = 10_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Balances,
    Supply,
    Tokens,
    Registered,
    Npcs,
    Trades,
    Approvals,
    Days,
    Listings,
    Traders,
    TraderImports,
    Orders,
    Ops,
    Released,
    OpenOrders,
    Plants,
    PlantsByOwner,
    PlantSales,
    Epochs,
    Grants,
    GrantedTo,
    NpcLimits,
    PowerOrders,
}

/// A registered exchange trader (an NPC with its own Testnet account and key).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TraderConfig {
    /// Most units the trader may import (mint to itself) per UTC day.
    pub max_import_per_day: U128,
}

/// An ask on the shared exchange. The escrowed tokens are held by the contract account.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Order {
    pub order_id: String,
    pub owner_id: AccountId,
    pub token_id: TokenId,
    pub amount: U128,
    pub remaining: U128,
    /// Off-chain, non-redeemable BLACKOUT credits per token unit (recorded for transparency).
    pub unit_price_cc: U128,
    /// "open" | "filled" | "cancelled"
    pub status: String,
    pub block_height: u64,
}

/// Receipt for a single-use exchange operation (deposit, redeem, fill, import).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct OpRecord {
    pub kind: String,
    pub account_id: AccountId,
    pub counterparty_id: Option<AccountId>,
    pub order_id: Option<String>,
    pub token_id: TokenId,
    pub amount: U128,
    pub block_height: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TokenInfo {
    pub token_id: TokenId,
    pub description: String,
    pub unit: String,
}

/// NEP-245 Token view.
#[near(serializers = [json])]
pub struct Token {
    pub token_id: TokenId,
    pub owner_id: Option<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct NpcConfig {
    pub max_per_call: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TradeRecord {
    pub seller_id: AccountId,
    pub receiver_id: AccountId,
    pub token_id: TokenId,
    pub amount: U128,
    pub block_height: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Approval {
    pub approval_id: u64,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct DaySettlement {
    pub run_id: String,
    pub day: u32,
    pub diesel_burned_units: U128,
    pub co2_g: U128,
    pub permits_retired: U128,
    pub block_height: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Listing {
    pub listing_id: String,
    /// Opaque game player id authenticated by the API before escrow.
    pub seller_id: String,
    pub token_id: TokenId,
    pub amount: U128,
    /// Off-chain, non-redeemable BLACKOUT credits per token unit.
    pub unit_price_cc: U128,
    pub status: String,
    pub buyer_id: Option<AccountId>,
    pub block_height: u64,
}

impl OpRecord {
    fn new(kind: &str, account_id: &AccountId, counterparty_id: Option<&AccountId>, order_id: Option<&String>, token_id: &TokenId, amount: U128) -> Self {
        Self {
            kind: kind.to_string(),
            account_id: account_id.clone(),
            counterparty_id: counterparty_id.cloned(),
            order_id: order_id.cloned(),
            token_id: token_id.clone(),
            amount,
            block_height: env::block_height(),
        }
    }
}

#[ext_contract(ext_mt_receiver)]
pub trait MultiTokenReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

#[ext_contract(ext_self)]
pub trait MultiTokenResolver {
    fn mt_resolve_transfer(
        &mut self,
        previous_owner_ids: Vec<AccountId>,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
    ) -> Vec<U128>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    operator_id: AccountId,
    balances: LookupMap<String, u128>,
    supply: LookupMap<TokenId, u128>,
    tokens: Vector<TokenInfo>,
    registered: LookupSet<AccountId>,
    npcs: LookupMap<AccountId, NpcConfig>,
    trades: LookupMap<String, TradeRecord>,
    /// key: "<token_id>|<owner_id>" -> approved account -> approval
    approvals: LookupMap<String, HashMap<AccountId, Approval>>,
    next_approval_id: u64,
    days: LookupMap<String, DaySettlement>,
    listings: LookupMap<String, Listing>,
    traders: LookupMap<AccountId, TraderConfig>,
    /// key: "<trader>|<utc day>" -> units imported that day
    trader_imports: LookupMap<String, u128>,
    orders: LookupMap<String, Order>,
    /// key: "<kind>:<id>" -> receipt; makes every exchange operation single-use
    ops: LookupMap<String, OpRecord>,
    /// player ids whose owner took self-custody: the operator can no longer act for them
    released: LookupSet<AccountId>,
    /// open offers per owner, so self-custody can never strand escrowed fuel
    open_orders: LookupMap<AccountId, u32>,
    /// NEP-171 Plant Assets (see plants.rs)
    plants: LookupMap<String, plants::PlantAsset>,
    plants_by_owner: LookupMap<AccountId, Vec<String>>,
    plant_sales: LookupMap<String, plants::PlantSale>,
    plant_count: u64,
    /// settlement epochs already applied (see plants.rs)
    epochs: LookupMap<String, plants::EpochRecord>,
    /// the fixed-supply treasury (see economy.rs); None until `init_economy`
    economy: Option<economy::EconomyState>,
    grants: LookupMap<String, economy::GrantRecord>,
    /// "<bucket>|<account>" -> grant id, for once-per-account buckets
    granted_to: LookupMap<String, String>,
    npc_limits: LookupMap<AccountId, economy::NpcLimits>,
    pub(crate) power_orders: LookupMap<String, economy::PowerOrder>,
}

const NANOS_PER_DAY: u64 = 86_400_000_000_000;

fn bkey(token_id: &str, account: &AccountId) -> String {
    format!("{}|{}", token_id, account)
}

fn emit(event: &str, data: serde_json::Value) {
    let ev = serde_json::json!({ "standard": "nep245", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{}", ev));
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, operator_id: AccountId) -> Self {
        let mut c = Self {
            owner_id: owner_id.clone(),
            operator_id: operator_id.clone(),
            balances: LookupMap::new(StorageKey::Balances),
            supply: LookupMap::new(StorageKey::Supply),
            tokens: Vector::new(StorageKey::Tokens),
            registered: LookupSet::new(StorageKey::Registered),
            npcs: LookupMap::new(StorageKey::Npcs),
            trades: LookupMap::new(StorageKey::Trades),
            approvals: LookupMap::new(StorageKey::Approvals),
            next_approval_id: 0,
            days: LookupMap::new(StorageKey::Days),
            listings: LookupMap::new(StorageKey::Listings),
            traders: LookupMap::new(StorageKey::Traders),
            trader_imports: LookupMap::new(StorageKey::TraderImports),
            orders: LookupMap::new(StorageKey::Orders),
            ops: LookupMap::new(StorageKey::Ops),
            released: LookupSet::new(StorageKey::Released),
            open_orders: LookupMap::new(StorageKey::OpenOrders),
            plants: LookupMap::new(StorageKey::Plants),
            plants_by_owner: LookupMap::new(StorageKey::PlantsByOwner),
            plant_sales: LookupMap::new(StorageKey::PlantSales),
            plant_count: 0,
            epochs: LookupMap::new(StorageKey::Epochs),
            economy: None,
            grants: LookupMap::new(StorageKey::Grants),
            granted_to: LookupMap::new(StorageKey::GrantedTo),
            npc_limits: LookupMap::new(StorageKey::NpcLimits),
            power_orders: LookupMap::new(StorageKey::PowerOrders),
        };
        c.registered.insert(owner_id);
        c.registered.insert(operator_id);
        c.registered.insert(env::current_account_id());
        c
    }

    // ------------------------------------------------------------------ admin

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner");
    }

    pub fn register_token(&mut self, token_id: TokenId, description: String, unit: String) {
        self.assert_owner();
        require!(!token_id.is_empty() && token_id.len() <= 64, "Bad token id");
        require!(self.supply.get(&token_id).is_none(), "Token already registered");
        self.supply.insert(token_id.clone(), 0);
        self.tokens.push(TokenInfo { token_id, description, unit });
    }

    /// Mints game resources to a registered account (e.g. merchant inventory at bootstrap).
    pub fn mt_mint(&mut self, owner_id: AccountId, token_ids: Vec<TokenId>, amounts: Vec<U128>, memo: Option<String>) {
        self.assert_owner();
        require!(token_ids.len() == amounts.len(), "Length mismatch");
        require!(self.registered.contains(&owner_id), "Receiver not registered for storage");
        for (t, a) in token_ids.iter().zip(amounts.iter()) {
            // credits have a fixed supply once the economy exists: only `issue` (bounded, audited) can add more
            require!(!(self.economy.is_some() && t == plants::CREDIT), "Vesper credits have a fixed supply: use issue()");
            let s = self.supply.get(t).copied().unwrap_or_else(|| env::panic_str("Unknown token"));
            self.supply.insert(t.clone(), s.checked_add(a.0).expect("supply overflow"));
            let k = bkey(t, &owner_id);
            let b = self.balances.get(&k).copied().unwrap_or(0);
            self.balances.insert(k, b.checked_add(a.0).expect("balance overflow"));
        }
        emit("mt_mint", serde_json::json!({ "owner_id": owner_id, "token_ids": token_ids, "amounts": amounts, "memo": memo }));
    }

    pub fn register_npc(&mut self, account_id: AccountId, max_per_call: U128) {
        self.assert_owner();
        require!(self.registered.contains(&account_id), "NPC must be storage-registered");
        self.npcs.insert(account_id, NpcConfig { max_per_call });
    }

    pub fn remove_npc(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.npcs.remove(&account_id);
    }

    // ------------------------------------------------------------------ storage

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> bool {
        let acct = account_id.unwrap_or_else(env::predecessor_account_id);
        let dep = env::attached_deposit();
        if self.registered.contains(&acct) {
            if !dep.is_zero() {
                let _refund = near_sdk::Promise::new(env::predecessor_account_id()).transfer(dep);
            }
            return false;
        }
        require!(dep >= STORAGE_DEPOSIT, "Attach at least 0.01 NEAR for storage");
        self.registered.insert(acct);
        let refund = dep.saturating_sub(STORAGE_DEPOSIT);
        if !refund.is_zero() {
            let _refund = near_sdk::Promise::new(env::predecessor_account_id()).transfer(refund);
        }
        true
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<U128> {
        if self.registered.contains(&account_id) {
            Some(U128(STORAGE_DEPOSIT.as_yoctonear()))
        } else {
            None
        }
    }

    // ------------------------------------------------------------------ internals

    fn internal_move(&mut self, from: &AccountId, to: &AccountId, token_id: &TokenId, amount: u128) {
        require!(amount > 0, "Amount must be positive");
        require!(from != to, "Sender and receiver must differ");
        require!(self.supply.get(token_id).is_some(), "Unknown token");
        require!(self.registered.contains(to), "Receiver not registered for storage");
        let fk = bkey(token_id, from);
        let fb = self.balances.get(&fk).copied().unwrap_or(0);
        require!(fb >= amount, "Insufficient balance");
        self.balances.insert(fk, fb - amount);
        let tk = bkey(token_id, to);
        let tb = self.balances.get(&tk).copied().unwrap_or(0);
        self.balances.insert(tk, tb.checked_add(amount).expect("balance overflow"));
    }

    /// Resolves who the owner is and consumes approval allowance when a third party moves tokens.
    fn internal_authorize(&mut self, sender: &AccountId, token_id: &TokenId, amount: u128, approval: &Option<(AccountId, u64)>) -> AccountId {
        match approval {
            None => sender.clone(),
            Some((owner_id, approval_id)) => {
                if owner_id == sender {
                    return sender.clone();
                }
                let k = bkey(token_id, owner_id);
                let mut map = self.approvals.get(&k).cloned().unwrap_or_default();
                let a = map.get(sender).cloned().unwrap_or_else(|| env::panic_str("Not approved"));
                require!(a.approval_id == *approval_id, "Approval id mismatch");
                require!(a.amount.0 >= amount, "Approved amount exceeded");
                let left = a.amount.0 - amount;
                if left == 0 {
                    map.remove(sender);
                } else {
                    map.insert(sender.clone(), Approval { approval_id: a.approval_id, amount: U128(left) });
                }
                self.approvals.insert(k, map);
                owner_id.clone()
            }
        }
    }

    fn internal_batch(
        &mut self,
        receiver_id: &AccountId,
        token_ids: &[TokenId],
        amounts: &[U128],
        approvals: &Option<Vec<Option<(AccountId, u64)>>>,
        memo: &Option<String>,
    ) -> Vec<AccountId> {
        require!(!token_ids.is_empty() && token_ids.len() == amounts.len(), "token_ids and amounts length mismatch");
        if let Some(a) = approvals {
            require!(a.len() == token_ids.len(), "approvals length mismatch");
        }
        let sender = env::predecessor_account_id();
        let mut owners = Vec::with_capacity(token_ids.len());
        for (i, t) in token_ids.iter().enumerate() {
            let approval = approvals.as_ref().and_then(|a| a[i].clone());
            let owner = self.internal_authorize(&sender, t, amounts[i].0, &approval);
            self.internal_move(&owner, receiver_id, t, amounts[i].0);
            let authorized = if owner != sender { Some(sender.clone()) } else { None };
            emit(
                "mt_transfer",
                serde_json::json!({ "authorized_id": authorized, "old_owner_id": owner, "new_owner_id": receiver_id, "token_ids": [t], "amounts": [amounts[i]], "memo": memo }),
            );
            owners.push(owner);
        }
        owners
    }

    // ------------------------------------------------------------------ NEP-245 core

    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        assert_one_yocto();
        self.internal_batch(&receiver_id, &[token_id], &[amount], &Some(vec![approval]), &memo);
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        self.internal_batch(&receiver_id, &token_ids, &amounts, &approvals, &memo);
    }

    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        self.mt_batch_transfer_call(receiver_id, vec![token_id], vec![amount], Some(vec![approval]), memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        assert_one_yocto();
        let owners = self.internal_batch(&receiver_id, &token_ids, &amounts, &approvals, &memo);
        ext_mt_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_ON_TRANSFER)
            .mt_on_transfer(env::predecessor_account_id(), owners.clone(), token_ids.clone(), amounts.clone(), msg)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).mt_resolve_transfer(owners, receiver_id, token_ids, amounts))
            .into()
    }

    /// Returns the amounts actually kept by the receiver. Unused amounts (or all of
    /// them if the receiver call failed) are returned to the previous owners.
    #[private]
    pub fn mt_resolve_transfer(&mut self, previous_owner_ids: Vec<AccountId>, receiver_id: AccountId, token_ids: Vec<TokenId>, amounts: Vec<U128>) -> Vec<U128> {
        // A failed, oversized or malformed receiver response refunds everything.
        let unused: Vec<U128> = match env::promise_result_checked(0, 16 * 1024) {
            Ok(v) => match serde_json::from_slice::<Vec<U128>>(&v) {
                Ok(u) if u.len() == amounts.len() => u.iter().zip(amounts.iter()).map(|(x, a)| U128(x.0.min(a.0))).collect(),
                _ => amounts.clone(),
            },
            Err(_) => amounts.clone(),
        };
        let mut kept = Vec::with_capacity(amounts.len());
        for i in 0..token_ids.len() {
            let rk = bkey(&token_ids[i], &receiver_id);
            let rb = self.balances.get(&rk).copied().unwrap_or(0);
            let refund = unused[i].0.min(rb);
            if refund > 0 {
                self.balances.insert(rk, rb - refund);
                let ok = bkey(&token_ids[i], &previous_owner_ids[i]);
                let ob = self.balances.get(&ok).copied().unwrap_or(0);
                self.balances.insert(ok, ob + refund);
                emit(
                    "mt_transfer",
                    serde_json::json!({ "old_owner_id": receiver_id, "new_owner_id": previous_owner_ids[i], "token_ids": [token_ids[i]], "amounts": [U128(refund)], "memo": "refund" }),
                );
            }
            kept.push(U128(amounts[i].0 - refund));
        }
        kept
    }

    pub fn mt_token(&self, token_ids: Vec<TokenId>) -> Vec<Option<Token>> {
        token_ids
            .into_iter()
            .map(|t| if self.supply.get(&t).is_some() { Some(Token { token_id: t, owner_id: None }) } else { None })
            .collect()
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: TokenId) -> U128 {
        U128(self.balances.get(&bkey(&token_id, &account_id)).copied().unwrap_or(0))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<TokenId>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.balances.get(&bkey(t, &account_id)).copied().unwrap_or(0))).collect()
    }

    pub fn mt_supply(&self, token_id: TokenId) -> Option<U128> {
        self.supply.get(&token_id).map(|s| U128(*s))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<TokenId>) -> Vec<Option<U128>> {
        token_ids.iter().map(|t| self.supply.get(t).map(|s| U128(*s))).collect()
    }

    pub fn mt_tokens_info(&self) -> Vec<TokenInfo> {
        self.tokens.iter().cloned().collect()
    }

    // ------------------------------------------------------------------ approvals

    #[payable]
    pub fn mt_approve(&mut self, token_ids: Vec<TokenId>, amounts: Vec<U128>, account_id: AccountId, msg: Option<String>) {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "Requires attached deposit of at least 1 yoctoNEAR");
        require!(token_ids.len() == amounts.len(), "Length mismatch");
        let owner = env::predecessor_account_id();
        for (t, a) in token_ids.iter().zip(amounts.iter()) {
            require!(self.supply.get(t).is_some(), "Unknown token");
            self.next_approval_id += 1;
            let k = bkey(t, &owner);
            let mut map = self.approvals.get(&k).cloned().unwrap_or_default();
            map.insert(account_id.clone(), Approval { approval_id: self.next_approval_id, amount: *a });
            self.approvals.insert(k, map);
        }
        let _ = msg; // no approval-receiver callback in this release
    }

    #[payable]
    pub fn mt_revoke(&mut self, token_ids: Vec<TokenId>, account_id: AccountId) {
        assert_one_yocto();
        let owner = env::predecessor_account_id();
        for t in token_ids.iter() {
            let k = bkey(t, &owner);
            if let Some(mut map) = self.approvals.get(&k).cloned() {
                map.remove(&account_id);
                self.approvals.insert(k, map);
            }
        }
    }

    /// NEP-245 approval management: revoke every approval the caller granted on these tokens.
    #[payable]
    pub fn mt_revoke_all(&mut self, token_ids: Vec<TokenId>) {
        assert_one_yocto();
        let owner = env::predecessor_account_id();
        for t in token_ids.iter() {
            let k = bkey(t, &owner);
            if self.approvals.get(&k).is_some() {
                self.approvals.insert(k, HashMap::new());
            }
        }
    }

    /// NEP-245 approval check. Deviation: balances are fungible per (token, owner), so the
    /// owner must be named explicitly (`owner_id`); the standard's signature omits it.
    pub fn mt_is_approved(&self, owner_id: AccountId, token_ids: Vec<TokenId>, approved_account_id: AccountId, amounts: Vec<U128>, approval_ids: Option<Vec<u64>>) -> bool {
        if token_ids.len() != amounts.len() {
            return false;
        }
        for (i, t) in token_ids.iter().enumerate() {
            let a = match self.approvals.get(&bkey(t, &owner_id)).and_then(|m| m.get(&approved_account_id).cloned()) {
                Some(a) => a,
                None => return false,
            };
            if a.amount.0 < amounts[i].0 {
                return false;
            }
            if let Some(ids) = &approval_ids {
                if ids.get(i) != Some(&a.approval_id) {
                    return false;
                }
            }
        }
        true
    }

    pub fn mt_approval_of(&self, owner_id: AccountId, token_id: TokenId, account_id: AccountId) -> Option<Approval> {
        self.approvals.get(&bkey(&token_id, &owner_id)).and_then(|m| m.get(&account_id).cloned())
    }

    // ------------------------------------------------------------------ game extensions

    /// NPC merchant sells its OWN tokens. No deposit so a function-call key can sign it.
    pub fn npc_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, amount: U128, memo: Option<String>, trade_id: String) {
        let npc = env::predecessor_account_id();
        let cfg = self.npcs.get(&npc).cloned().unwrap_or_else(|| env::panic_str("Caller is not a registered NPC"));
        require!(amount.0 <= cfg.max_per_call.0, "Amount exceeds NPC per-call cap");
        require!(!trade_id.is_empty() && trade_id.len() <= 128, "Bad trade id");
        require!(self.trades.get(&trade_id).is_none(), "Trade already processed");
        self.internal_move(&npc, &receiver_id, &token_id, amount.0);
        self.trades.insert(
            trade_id.clone(),
            TradeRecord { seller_id: npc.clone(), receiver_id: receiver_id.clone(), token_id: token_id.clone(), amount, block_height: env::block_height() },
        );
        emit("mt_transfer", serde_json::json!({ "old_owner_id": npc, "new_owner_id": receiver_id, "token_ids": [token_id], "amounts": [amount], "memo": memo.unwrap_or(trade_id) }));
    }

    pub fn trade_status(&self, trade_id: String) -> Option<TradeRecord> {
        self.trades.get(&trade_id).cloned()
    }

    /// The custodial operator escrows resources for an authenticated game player.
    /// The API must verify the player's unreserved game balance before calling this method.
    pub fn custodial_list(&mut self, seller_id: String, listing_id: String, token_id: TokenId, amount: U128, unit_price_cc: U128) {
        require!(env::predecessor_account_id() == self.operator_id, "Only the game operator");
        require!(!seller_id.is_empty() && seller_id.len() <= 128, "Bad seller id");
        require!(!listing_id.is_empty() && listing_id.len() <= 128, "Bad listing id");
        require!(amount.0 > 0 && unit_price_cc.0 > 0, "Amount and price must be positive");
        require!(self.supply.get(&token_id).is_some(), "Unknown token");
        require!(self.listings.get(&listing_id).is_none(), "Listing already exists");
        let contract_id = env::current_account_id();
        let operator_id = self.operator_id.clone();
        self.internal_move(&operator_id, &contract_id, &token_id, amount.0);
        self.listings.insert(listing_id.clone(), Listing {
            listing_id: listing_id.clone(), seller_id: seller_id.clone(), token_id: token_id.clone(),
            amount, unit_price_cc, status: "active".to_string(), buyer_id: None, block_height: env::block_height(),
        });
        emit("mt_transfer", serde_json::json!({ "old_owner_id": operator_id, "new_owner_id": contract_id, "token_ids": [token_id], "amounts": [amount], "memo": format!("listing:{}:{}", listing_id, seller_id) }));
    }

    /// Cancel an active custodial listing and return its escrowed resource to the vault.
    pub fn custodial_cancel_listing(&mut self, listing_id: String) {
        require!(env::predecessor_account_id() == self.operator_id, "Only the game operator");
        let mut listing = self.listings.get(&listing_id).cloned().unwrap_or_else(|| env::panic_str("Unknown listing"));
        require!(listing.status == "active", "Listing is not active");
        let contract_id = env::current_account_id();
        let operator_id = self.operator_id.clone();
        self.internal_move(&contract_id, &operator_id, &listing.token_id, listing.amount.0);
        listing.status = "cancelled".to_string();
        listing.block_height = env::block_height();
        self.listings.insert(listing_id.clone(), listing.clone());
        emit("mt_transfer", serde_json::json!({ "old_owner_id": contract_id, "new_owner_id": operator_id, "token_ids": [listing.token_id], "amounts": [listing.amount], "memo": format!("listing_cancel:{}:{}", listing_id, listing.seller_id) }));
    }

    /// The restricted operator key settles an NPC purchase after its policy approves it.
    /// The buyer must be a registered NPC, and only escrowed listing resources can move.
    pub fn custodial_fill_listing(&mut self, listing_id: String, buyer_id: AccountId) {
        require!(env::predecessor_account_id() == self.operator_id, "Only the game operator");
        require!(self.npcs.get(&buyer_id).is_some(), "Buyer is not a registered NPC");
        let mut listing = self.listings.get(&listing_id).cloned().unwrap_or_else(|| env::panic_str("Unknown listing"));
        require!(listing.status == "active", "Listing is not active");
        let contract_id = env::current_account_id();
        self.internal_move(&contract_id, &buyer_id, &listing.token_id, listing.amount.0);
        listing.status = "filled".to_string();
        listing.buyer_id = Some(buyer_id.clone());
        listing.block_height = env::block_height();
        self.listings.insert(listing_id.clone(), listing.clone());
        emit("mt_transfer", serde_json::json!({ "old_owner_id": contract_id, "new_owner_id": buyer_id, "token_ids": [listing.token_id], "amounts": [listing.amount], "memo": format!("listing_fill:{}:{}", listing_id, listing.seller_id) }));
    }

    pub fn listing(&self, listing_id: String) -> Option<Listing> {
        self.listings.get(&listing_id).cloned()
    }

    /// Operator burns diesel it consumed in simulation from its OWN balance, after the
    /// contract checks the day's batch is internally consistent.
    pub fn settle_day(&mut self, run_id: String, day: u32, diesel_burned_units: U128, co2_g: U128, permits_retired: U128) {
        let op = env::predecessor_account_id();
        require!(op == self.operator_id, "Only the game operator");
        require!(co2_g.0 == diesel_burned_units.0 * CO2_G_PER_DIESEL_UNIT, "CO2 must equal diesel x 2.68 kg/L");
        require!(permits_retired.0 * PERMIT_G >= co2_g.0, "Retired permits do not cover CO2");
        let key = format!("{}#{}", run_id, day);
        require!(self.days.get(&key).is_none(), "Day already settled");
        let t: TokenId = "DIESEL_100ML".to_string();
        if diesel_burned_units.0 > 0 {
            let k = bkey(&t, &op);
            let b = self.balances.get(&k).copied().unwrap_or(0);
            require!(b >= diesel_burned_units.0, "Operator custody holds less diesel than it claims to have burned");
            self.balances.insert(k, b - diesel_burned_units.0);
            let s = self.supply.get(&t).copied().unwrap_or(0);
            self.supply.insert(t.clone(), s - diesel_burned_units.0);
            emit("mt_burn", serde_json::json!({ "owner_id": op, "token_ids": [t], "amounts": [diesel_burned_units], "memo": key }));
        }
        self.days.insert(key, DaySettlement { run_id, day, diesel_burned_units, co2_g, permits_retired, block_height: env::block_height() });
    }

    pub fn day_settlement(&self, run_id: String, day: u32) -> Option<DaySettlement> {
        self.days.get(&format!("{}#{}", run_id, day)).cloned()
    }

    // ------------------------------------------------------------------ shared fuel exchange

    /// Owner registers an exchange trader. Its own function-call key then signs its asks, fills and imports.
    pub fn register_trader(&mut self, account_id: AccountId, max_import_per_day: U128) {
        self.assert_owner();
        require!(self.registered.contains(&account_id), "Trader must be storage-registered");
        require!(account_id != self.operator_id && !self.is_player_id(&account_id), "A trader cannot be the operator or a player id");
        self.traders.insert(account_id, TraderConfig { max_import_per_day });
    }

    /// Operator moves fuel from a city tank onto the exchange: mints to the player's exchange balance.
    pub fn exchange_deposit(&mut self, player_id: AccountId, token_id: TokenId, amount: U128, deposit_id: String) {
        self.assert_operator();
        self.assert_player_id(&player_id);
        require!(amount.0 > 0, "Amount must be positive");
        self.claim_op("deposit", &deposit_id, OpRecord::new("deposit", &player_id, None, None, &token_id, amount));
        self.registered.insert(player_id.clone());
        self.internal_mint(&player_id, &token_id, amount.0, &format!("deposit:{}", deposit_id));
    }

    /// Operator brings fuel home to a city tank: burns it from the player's exchange balance.
    pub fn exchange_redeem(&mut self, player_id: AccountId, token_id: TokenId, amount: U128, redeem_id: String) {
        self.assert_operator();
        self.assert_player_id(&player_id);
        require!(amount.0 > 0, "Amount must be positive");
        self.claim_op("redeem", &redeem_id, OpRecord::new("redeem", &player_id, None, None, &token_id, amount));
        self.internal_burn(&player_id, &token_id, amount.0, &format!("redeem:{}", redeem_id));
    }

    /// Places an ask and escrows its tokens in the contract. The operator may place asks only for player ids;
    /// a trader only for itself.
    pub fn exchange_ask(&mut self, owner_id: AccountId, order_id: String, token_id: TokenId, amount: U128, unit_price_cc: U128) {
        let caller = env::predecessor_account_id();
        let by_operator = caller == self.operator_id && self.is_player_id(&owner_id);
        let by_trader = caller == owner_id && self.traders.get(&owner_id).is_some();
        require!(by_operator || by_trader, "Only the operator (for a player) or the trader itself can place this ask");
        require!(!order_id.is_empty() && order_id.len() <= 128, "Bad order id");
        require!(amount.0 > 0 && unit_price_cc.0 > 0, "Amount and price must be positive");
        require!(self.orders.get(&order_id).is_none(), "Order already exists");
        let escrow = env::current_account_id();
        self.internal_move(&owner_id, &escrow, &token_id, amount.0);
        self.orders.insert(order_id.clone(), Order {
            order_id: order_id.clone(), owner_id: owner_id.clone(), token_id: token_id.clone(), amount, remaining: amount,
            unit_price_cc, status: "open".to_string(), block_height: env::block_height(),
        });
        self.bump_open(&owner_id, 1);
        emit("mt_transfer", serde_json::json!({ "authorized_id": if by_operator { Some(caller) } else { None }, "old_owner_id": owner_id, "new_owner_id": escrow, "token_ids": [token_id], "amounts": [amount], "memo": format!("ask:{}", order_id) }));
    }

    /// Cancels an open ask and returns what is left in escrow to its owner.
    pub fn exchange_cancel(&mut self, order_id: String) {
        let caller = env::predecessor_account_id();
        let mut order = self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("Unknown order"));
        require!(order.status == "open", "Order is not open");
        let by_operator = caller == self.operator_id && self.is_player_id(&order.owner_id);
        let by_trader = caller == order.owner_id && self.traders.get(&caller).is_some();
        require!(by_operator || by_trader, "Only the order's owner can cancel it");
        let escrow = env::current_account_id();
        let left = order.remaining;
        self.internal_move(&escrow, &order.owner_id, &order.token_id, left.0);
        order.remaining = U128(0);
        order.status = "cancelled".to_string();
        self.bump_open(&order.owner_id, -1);
        order.block_height = env::block_height();
        self.orders.insert(order_id.clone(), order.clone());
        emit("mt_transfer", serde_json::json!({ "authorized_id": if by_operator { Some(caller) } else { None }, "old_owner_id": escrow, "new_owner_id": order.owner_id, "token_ids": [order.token_id], "amounts": [left], "memo": format!("cancel:{}", order_id) }));
    }

    /// Fills all or part of an open ask. The operator may buy only for player ids; a trader only for itself.
    pub fn exchange_fill(&mut self, order_id: String, buyer_id: AccountId, amount: U128, fill_id: String) {
        let caller = env::predecessor_account_id();
        let by_operator = caller == self.operator_id && self.is_player_id(&buyer_id);
        let by_trader = caller == buyer_id && self.traders.get(&buyer_id).is_some();
        require!(by_operator || by_trader, "Only the operator (for a player) or the trader itself can buy");
        let mut order = self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("Unknown order"));
        require!(order.status == "open", "Order is not open");
        require!(order.owner_id != buyer_id, "Cannot buy your own order");
        require!(amount.0 > 0 && amount.0 <= order.remaining.0, "Amount exceeds what is left on the order");
        self.claim_op("fill", &fill_id, OpRecord::new("fill", &buyer_id, Some(&order.owner_id), Some(&order_id), &order.token_id, amount));
        if by_operator {
            self.registered.insert(buyer_id.clone());
        }
        let escrow = env::current_account_id();
        self.internal_move(&escrow, &buyer_id, &order.token_id, amount.0);
        order.remaining = U128(order.remaining.0 - amount.0);
        if order.remaining.0 == 0 {
            order.status = "filled".to_string();
            self.bump_open(&order.owner_id, -1);
        }
        order.block_height = env::block_height();
        self.orders.insert(order_id.clone(), order.clone());
        emit("mt_transfer", serde_json::json!({ "authorized_id": if by_operator { Some(caller) } else { None }, "old_owner_id": escrow, "new_owner_id": buyer_id, "token_ids": [order.token_id], "amounts": [amount], "memo": format!("fill:{}:{}", fill_id, order_id) }));
    }

    /// A trader imports fuel from outside the city economy, capped per UTC day by the owner.
    pub fn npc_import(&mut self, token_id: TokenId, amount: U128, import_id: String) {
        let trader = env::predecessor_account_id();
        let cfg = self.traders.get(&trader).cloned().unwrap_or_else(|| env::panic_str("Caller is not a registered trader"));
        require!(amount.0 > 0, "Amount must be positive");
        let key = format!("{}|{}", trader, env::block_timestamp() / NANOS_PER_DAY);
        let used = self.trader_imports.get(&key).copied().unwrap_or(0);
        require!(used.checked_add(amount.0).map_or(false, |t| t <= cfg.max_import_per_day.0), "Daily import cap reached");
        self.claim_op("import", &import_id, OpRecord::new("import", &trader, None, None, &token_id, amount));
        self.trader_imports.insert(key, used + amount.0);
        self.internal_mint(&trader, &token_id, amount.0, &format!("import:{}", import_id));
    }

    /// A trader sells fuel to the fuel merchants of players' cities: the tokens leave the exchange (burned from the
    /// trader's own balance). Payment is off-chain game credits. Single-use per `supply_id`.
    pub fn npc_supply_city(&mut self, token_id: TokenId, amount: U128, supply_id: String) {
        let trader = env::predecessor_account_id();
        require!(self.traders.get(&trader).is_some(), "Caller is not a registered trader");
        require!(amount.0 > 0, "Amount must be positive");
        self.claim_op("supply", &supply_id, OpRecord::new("supply", &trader, None, None, &token_id, amount));
        self.internal_burn(&trader, &token_id, amount.0, &format!("supply:{}", supply_id));
    }

    pub fn exchange_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    /// Receipt for a single-use operation; `op_id` is "<kind>:<id>", e.g. "fill:abc".
    pub fn exchange_op(&self, op_id: String) -> Option<OpRecord> {
        self.ops.get(&op_id).cloned()
    }

    pub fn trader_config(&self, account_id: AccountId) -> Option<TraderConfig> {
        self.traders.get(&account_id).cloned()
    }

    /// Player exchange ids must end with this suffix.
    pub fn player_namespace(&self) -> String {
        format!(".{}", self.operator_id)
    }

    fn assert_operator(&self) {
        require!(env::predecessor_account_id() == self.operator_id, "Only the game operator");
    }

    fn is_player_id(&self, account_id: &AccountId) -> bool {
        if self.released.contains(account_id) {
            return false;
        }
        let s = account_id.as_str();
        let under = |parent: &str| {
            let suffix = format!(".{}", parent);
            s.len() > suffix.len() && s.ends_with(&suffix)
        };
        under(self.operator_id.as_str()) || self.economy.as_ref().map(|e| under(e.player_parent_id.as_str())).unwrap_or(false)
    }

    fn bump_open(&mut self, owner: &AccountId, delta: i64) {
        let n = self.open_orders.get(owner).copied().unwrap_or(0) as i64 + delta;
        self.open_orders.insert(owner.clone(), n.max(0) as u32);
    }

    /// A player whose namespaced account now exists (created by the vault with the player's own key)
    /// takes self-custody: the operator loses all power over this id. Requires no open offers.
    pub fn release_to_owner(&mut self) {
        let me = env::predecessor_account_id();
        require!(self.is_player_id(&me), "Only a player id in the operator's namespace can be released");
        require!(self.open_orders.get(&me).copied().unwrap_or(0) == 0, "Cancel your open offers first");
        self.released.insert(me.clone());
        env::log_str(&format!("released {} to self-custody", me));
    }

    pub fn is_released(&self, account_id: AccountId) -> bool {
        self.released.contains(&account_id)
    }

    fn assert_player_id(&self, account_id: &AccountId) {
        require!(self.is_player_id(account_id), "Not a player id in the operator's namespace");
    }

    fn claim_op(&mut self, kind: &str, id: &str, rec: OpRecord) {
        require!(!id.is_empty() && id.len() <= 128, "Bad operation id");
        let key = format!("{}:{}", kind, id);
        require!(self.ops.get(&key).is_none(), "Operation already processed");
        self.ops.insert(key, rec);
    }

    fn internal_mint(&mut self, owner_id: &AccountId, token_id: &TokenId, amount: u128, memo: &str) {
        let s = self.supply.get(token_id).copied().unwrap_or_else(|| env::panic_str("Unknown token"));
        self.supply.insert(token_id.clone(), s.checked_add(amount).expect("supply overflow"));
        let k = bkey(token_id, owner_id);
        let b = self.balances.get(&k).copied().unwrap_or(0);
        self.balances.insert(k, b.checked_add(amount).expect("balance overflow"));
        emit("mt_mint", serde_json::json!({ "owner_id": owner_id, "token_ids": [token_id], "amounts": [U128(amount)], "memo": memo }));
    }

    fn internal_burn(&mut self, owner_id: &AccountId, token_id: &TokenId, amount: u128, memo: &str) {
        let k = bkey(token_id, owner_id);
        let b = self.balances.get(&k).copied().unwrap_or(0);
        require!(b >= amount, "Insufficient balance");
        self.balances.insert(k, b - amount);
        let s = self.supply.get(token_id).copied().unwrap_or_else(|| env::panic_str("Unknown token"));
        self.supply.insert(token_id.clone(), s - amount);
        emit("mt_burn", serde_json::json!({ "owner_id": owner_id, "authorized_id": env::predecessor_account_id(), "token_ids": [token_id], "amounts": [U128(amount)], "memo": memo }));
    }

    pub fn contract_info(&self) -> serde_json::Value {
        serde_json::json!({ "standard": "nep245", "version": "1.0.0", "owner_id": self.owner_id, "operator_id": self.operator_id, "tokens": self.mt_tokens_info() })
    }
}

pub mod economy;
pub mod plants;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod plant_tests;
#[cfg(test)]
mod economy_tests;
