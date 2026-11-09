//! Treasury, starting capital, NPC limits, power-delivery escrow and batch settlement.
use super::economy::*;
use super::*;
use near_sdk::json_types::I64;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
const OWNER: &str = "owner.testnet";
const OP: &str = "vault.testnet";
const TREASURY: &str = "treasury.testnet";
const PLAYERS: &str = "players.testnet";
const ALICE: &str = "pa1.players.testnet"; // a player's wallet, under the player parent
const BOB: &str = "pb2.players.testnet";
const SMELTER: &str = "smelter.testnet"; // an NPC with its own account
const GASCO: &str = "gasco.testnet";
const OUTSIDER: &str = "outsider.testnet";
const C: &str = "credit:vesper";
const POOL: &str = "resources.testnet";

fn ctx_at(pred: &str, deposit: u128, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(POOL)).predecessor_account_id(acc(pred)).signer_account_id(acc(pred)).attached_deposit(NearToken::from_yoctonear(deposit)).block_timestamp(ts);
    testing_env!(b.build());
}
fn ctx(pred: &str, deposit: u128) {
    ctx_at(pred, deposit, 1_000_000_000_000);
}

fn panics<F: FnOnce()>(f: F, needle: &str) {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    let e = r.expect_err("expected a panic");
    let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    assert!(msg.contains(needle), "panic {:?} did not contain {:?}", msg, needle);
}

fn bucket(name: &str, cap: u128, max: u128, once: bool) -> BucketInput {
    BucketInput { name: name.into(), cap: U128(cap), max_per_grant: U128(max), once_per_account: once }
}

fn bal(c: &Contract, who: &str) -> u128 {
    c.mt_balance_of(acc(who), C.into()).0
}

/// 1,000,000 credits: city 400k, npc 250k (≤100k each, once), players 150k (≤5k each, once), world 100k, reserve 100k.
fn setup() -> Contract {
    ctx(OWNER, 0);
    let mut c = Contract::new(acc(OWNER), acc(OP));
    for t in [C, "fuel:diesel"] {
        c.register_token(t.into(), t.into(), "unit".into());
    }
    c.init_economy(
        acc(TREASURY),
        acc(PLAYERS),
        U128(1_000_000),
        vec![bucket("city", 400_000, 0, false), bucket("npc", 250_000, 100_000, true), bucket("players", 150_000, 5_000, true), bucket("world", 100_000, 0, false), bucket("reserve", 100_000, 0, false)],
        U128(200_000),
    );
    for n in [SMELTER, GASCO] {
        ctx(n, STORAGE_DEPOSIT.as_yoctonear());
        c.storage_deposit(None);
        ctx(OWNER, 0);
        c.register_npc(acc(n), U128(0));
        c.set_npc_limits(acc(n), U128(20_000), U128(50_000));
    }
    c
}

#[test]
fn genesis_mints_the_whole_supply_once_into_the_treasury() {
    let mut c = setup();
    assert_eq!(bal(&c, TREASURY), 1_000_000);
    assert_eq!(c.mt_supply(C.into()).unwrap().0, 1_000_000);
    ctx(OWNER, 0);
    panics(|| c.init_economy(acc(TREASURY), acc(PLAYERS), U128(5), vec![bucket("x", 5, 0, false)], U128(0)), "already initialised");
    // no back door: credits can't be minted directly any more
    panics(|| c.mt_mint(acc(TREASURY), vec![C.into()], vec![U128(1)], None), "fixed supply");
}

#[test]
fn genesis_refuses_premined_credits_and_caps_that_dont_add_up() {
    ctx(OWNER, 0);
    let mut c = Contract::new(acc(OWNER), acc(OP));
    c.register_token(C.into(), C.into(), "cc".into());
    panics(|| c.init_economy(acc(TREASURY), acc(PLAYERS), U128(100), vec![bucket("a", 60, 0, false), bucket("b", 30, 0, false)], U128(0)), "add up");
    c.mt_mint(acc(OP), vec![C.into()], vec![U128(10)], None);
    panics(|| c.init_economy(acc(TREASURY), acc(PLAYERS), U128(100), vec![bucket("a", 100, 0, false)], U128(0)), "before genesis");
}

#[test]
fn starting_capital_is_paid_once_per_account_within_the_bucket() {
    let mut c = setup();
    ctx(OP, 0);
    c.treasury_grant("start:alice".into(), "players".into(), acc(ALICE), U128(5_000), "starting capital".into());
    assert_eq!(bal(&c, ALICE), 5_000);
    assert_eq!(bal(&c, TREASURY), 995_000);
    assert_eq!(c.granted("players".into(), acc(ALICE)), Some("start:alice".into()));
    // the same request again (a refresh, a retry) is refused, and so is a new grant id to the same account
    panics(|| c.treasury_grant("start:alice".into(), "players".into(), acc(ALICE), U128(5_000), "again".into()), "already paid");
    panics(|| c.treasury_grant("start:alice-2".into(), "players".into(), acc(ALICE), U128(5_000), "again".into()), "already received");
    panics(|| c.treasury_grant("start:bob".into(), "players".into(), acc(BOB), U128(5_001), "too much".into()), "per-grant limit");
    // only the operator (or owner) can pay grants
    ctx(BOB, 0);
    panics(|| c.treasury_grant("start:bob".into(), "players".into(), acc(BOB), U128(5_000), "me".into()), "Only the game operator");
    // supply never changed
    assert_eq!(c.mt_supply(C.into()).unwrap().0, 1_000_000);
}

#[test]
fn an_exhausted_bucket_refuses_instead_of_minting() {
    let mut c = setup();
    ctx(OP, 0);
    for i in 0..30 {
        c.treasury_grant(format!("start:{}", i), "players".into(), acc(&format!("p{}.players.testnet", i)), U128(5_000), "start".into());
    }
    panics(|| c.treasury_grant("start:31".into(), "players".into(), acc("p31.players.testnet"), U128(5_000), "start".into()), "exhausted");
    assert_eq!(c.mt_supply(C.into()).unwrap().0, 1_000_000);
    // the owner can top the bucket up by issuing, but only within the lifetime cap
    ctx(OWNER, 0);
    c.issue("players".into(), U128(150_000), "season two: more players".into());
    ctx(OP, 0);
    c.treasury_grant("start:31".into(), "players".into(), acc("p31.players.testnet"), U128(5_000), "start".into());
    ctx(OWNER, 0);
    panics(|| c.issue("players".into(), U128(50_001), "more".into()), "lifetime issuance cap");
    ctx(OP, 0);
    panics(|| c.issue("players".into(), U128(1), "sneaky".into()), "Only the owner");
    assert_eq!(c.mt_supply(C.into()).unwrap().0, 1_150_000);
}

fn funded() -> Contract {
    let mut c = setup();
    ctx(OP, 0);
    c.treasury_grant("npc:smelter".into(), "npc".into(), acc(SMELTER), U128(60_000), "starting capital".into());
    c.treasury_grant("npc:gasco".into(), "npc".into(), acc(GASCO), U128(40_000), "starting capital".into());
    c.treasury_grant("start:alice".into(), "players".into(), acc(ALICE), U128(5_000), "starting capital".into());
    c
}

#[test]
fn an_npc_buys_power_from_a_player_paying_only_for_what_was_delivered() {
    let mut c = funded();
    // the smelter signs with its own function-call key: no deposit
    ctx(SMELTER, 0);
    c.power_order_place("o1".into(), acc(ALICE), 200, U128(50_000), 10, "solar down 45%: buying 200 kWh".into());
    assert_eq!(bal(&c, SMELTER), 60_000 - 10_000);
    assert_eq!(bal(&c, POOL), 10_000);
    // only the grid operator can say what was delivered
    ctx(ALICE, 0);
    panics(|| c.power_order_confirm("o1".into(), 200), "Only the grid operator");
    ctx(OP, 0);
    c.power_order_confirm("o1".into(), 150);
    // the closed order is deleted (storage released); the event is its record
    assert!(c.power_order("o1".into()).is_none());
    assert!(near_sdk::test_utils::get_logs().iter().any(|l| l.contains("power_order_settled") && l.contains("\"paid\":\"7500\"") && l.contains("\"refunded\":\"2500\"")));
    assert_eq!(bal(&c, ALICE), 5_000 + 7_500);
    assert_eq!(bal(&c, SMELTER), 60_000 - 7_500);
    assert_eq!(bal(&c, POOL), 0);
    panics(|| c.power_order_confirm("o1".into(), 150), "No such order");
    assert_eq!(c.mt_supply(C.into()).unwrap().0, 1_000_000);
}

#[test]
fn npc_to_npc_orders_and_order_ids_are_single_use() {
    let mut c = funded();
    ctx(SMELTER, 0);
    c.power_order_place("o2".into(), acc(GASCO), 100, U128(80_000), 10, "backup power".into());
    panics(|| c.power_order_place("o2".into(), acc(GASCO), 100, U128(80_000), 10, "replay".into()), "already used");
    ctx(OP, 0);
    c.power_order_confirm("o2".into(), 100);
    assert_eq!(bal(&c, GASCO), 40_000 + 8_000);
    assert_eq!(bal(&c, SMELTER), 60_000 - 8_000);
}

#[test]
fn npc_spending_is_bounded_and_can_be_switched_off() {
    let mut c = funded();
    ctx(SMELTER, 0);
    panics(|| c.power_order_place("big".into(), acc(ALICE), 1_000, U128(25_000), 10, "x".into()), "per-payment limit"); // 25,000 > 20,000
    c.power_order_place("a".into(), acc(ALICE), 400, U128(50_000), 10, "x".into()); // 20,000
    c.power_order_place("b".into(), acc(ALICE), 400, U128(50_000), 10, "x".into()); // 40,000 today
    panics(|| c.power_order_place("c".into(), acc(ALICE), 400, U128(50_000), 10, "x".into()), "daily spending limit");
    // a new day resets the daily limit
    ctx_at(SMELTER, 0, 1_000_000_000_000 + 86_400_000_000_000);
    c.power_order_place("c".into(), acc(GASCO), 10, U128(50_000), 10, "x".into());
    // the operator pulls one NPC's switch, then everyone's
    ctx(OP, 0);
    c.set_npc_paused(acc(SMELTER), true);
    ctx_at(SMELTER, 0, 1_000_000_000_000 + 86_400_000_000_000);
    panics(|| c.power_order_place("d".into(), acc(GASCO), 10, U128(50_000), 10, "x".into()), "spending is paused");
    ctx(OP, 0);
    c.set_npc_paused(acc(SMELTER), false);
    c.set_npc_spending_paused(true);
    ctx_at(GASCO, 0, 1_000_000_000_000 + 86_400_000_000_000);
    panics(|| c.power_order_place("e".into(), acc(ALICE), 10, U128(50_000), 10, "x".into()), "NPC spending is paused");
    // a stranger can't flip switches
    ctx(OUTSIDER, 0);
    panics(|| c.set_npc_spending_paused(false), "Only the owner or operator");
}

#[test]
fn an_npc_cannot_spend_money_it_does_not_have() {
    let mut c = funded();
    ctx(OWNER, 0);
    c.set_npc_limits(acc(GASCO), U128(1_000_000), U128(1_000_000));
    ctx(GASCO, 0);
    panics(|| c.power_order_place("x".into(), acc(ALICE), 1_000, U128(50_000), 10, "x".into()), "Insufficient"); // 50,000 > 40,000
    assert_eq!(bal(&c, GASCO), 40_000);
}

#[test]
fn players_attach_one_yocto_and_unconfirmed_orders_refund_after_expiry() {
    let mut c = funded();
    ctx(ALICE, 0);
    panics(|| c.power_order_place("p1".into(), acc(GASCO), 10, U128(50_000), 1, "x".into()), "1 yoctoNEAR");
    ctx(ALICE, 1);
    c.power_order_place("p1".into(), acc(GASCO), 10, U128(50_000), 1, "x".into());
    assert_eq!(bal(&c, ALICE), 5_000 - 500);
    ctx(OUTSIDER, 0);
    panics(|| c.power_order_expire("p1".into()), "Not expired yet");
    ctx_at(OUTSIDER, 0, 1_000_000_000_000 + 3 * 60_000_000_000);
    c.power_order_expire("p1".into());
    assert_eq!(bal(&c, ALICE), 5_000);
    assert!(c.power_order("p1".into()).is_none());
    ctx(OP, 0);
    panics(|| c.power_order_confirm("p1".into(), 10), "No such order");
}

#[test]
fn batch_settlement_moves_credits_and_items_together_with_consent_only() {
    let mut c = funded();
    ctx(OWNER, 0);
    c.mt_mint(acc(GASCO), vec!["fuel:diesel".into()], vec![U128(1_000)], None);
    ctx(OP, 0);
    // a market epoch: Alice buys 100 L of diesel from the gas company for 3,000 credits
    c.settle_batch(
        "town:1".into(),
        "a".repeat(64),
        vec![(C.into(), vec![(acc(ALICE), I64(-3_000)), (acc(GASCO), I64(3_000))]), ("fuel:diesel".into(), vec![(acc(GASCO), I64(-100)), (acc(ALICE), I64(100))])],
    );
    assert_eq!(bal(&c, ALICE), 2_000);
    assert_eq!(c.mt_balance_of(acc(ALICE), "fuel:diesel".into()).0, 100);
    panics(|| c.settle_batch("town:1".into(), "a".repeat(64), vec![(C.into(), vec![(acc(ALICE), I64(-1)), (acc(GASCO), I64(1))])]), "already settled");
    // a settled batch is remembered by a marker, readable through `epoch`
    assert!(c.epoch("town:1".into()).is_some());
    assert!(c.epoch("town:2".into()).is_none());
    // an account outside the game's custody can't be debited
    ctx(OUTSIDER, STORAGE_DEPOSIT.as_yoctonear());
    c.storage_deposit(None);
    ctx(OP, 0);
    panics(|| c.settle_batch("town:2".into(), "b".repeat(64), vec![(C.into(), vec![(acc(OUTSIDER), I64(-1)), (acc(GASCO), I64(1))])]), "didn't consent");
    panics(|| c.settle_batch("town:3".into(), "b".repeat(64), vec![(C.into(), vec![(acc(ALICE), I64(-2)), (acc(GASCO), I64(1))])]), "sum to zero");
}

#[test]
fn pruning_deletes_only_closed_orders_and_only_for_the_owner_or_operator() {
    let mut c = funded();
    ctx(SMELTER, 0);
    c.power_order_place("open1".into(), acc(GASCO), 10, U128(50_000), 10, "x".into());
    // an order closed under the old rules stays stored as "settled": prune deletes it, never an open one
    let mut closed = c.power_order("open1".into()).unwrap();
    closed.order_id = "old1".into();
    closed.status = "settled".into();
    c.power_orders.insert("old1".into(), closed);
    ctx(OUTSIDER, 0);
    panics(|| { c.prune_closed_orders(vec!["old1".into()]); }, "Only the owner or operator");
    ctx(OP, 0);
    assert_eq!(c.prune_closed_orders(vec!["old1".into(), "open1".into(), "nope".into()]), 1);
    assert!(c.power_order("old1".into()).is_none());
    assert_eq!(c.power_order("open1".into()).unwrap().status, "open");
}

#[test]
fn a_player_who_takes_self_custody_leaves_the_operators_reach() {
    let mut c = funded();
    ctx(ALICE, 0);
    c.release_to_owner();
    ctx(OP, 0);
    panics(|| c.settle_batch("t".into(), "c".repeat(64), vec![(C.into(), vec![(acc(ALICE), I64(-1)), (acc(GASCO), I64(1))])]), "didn't consent");
}
