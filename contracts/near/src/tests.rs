use super::*;
use crate::economy::BucketInput;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn ctx(pred: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("resources.testnet"))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}

const D: &str = "DIESEL_100ML";
const CREDIT: &str = "credit:vesper";

fn setup() -> Contract {
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acc("owner.testnet"), acc("vault.testnet"));
    c.register_token(D.into(), "100 mL of diesel".into(), "100mL".into());
    c.register_token("CARBON_PERMIT_10KG".into(), "10 kg CO2 permit".into(), "permit".into());
    for a in ["lantern.testnet", "ember.testnet", "player.testnet"] {
        ctx(a, STORAGE_DEPOSIT.as_yoctonear());
        assert!(c.storage_deposit(None));
    }
    ctx("owner.testnet", 0);
    c.mt_mint(acc("lantern.testnet"), vec![D.into()], vec![U128(300)], None);
    c.register_npc(acc("lantern.testnet"), U128(200));
    c.register_npc(acc("ember.testnet"), U128(200));
    c
}

fn setup_player_market() -> Contract {
    let mut c = setup();
    ctx("owner.testnet", 0);
    c.register_token(CREDIT.into(), "Vesper credits".into(), "cc".into());
    c.init_economy(
        acc("treasury.testnet"),
        acc("players.testnet"),
        U128(20_000),
        vec![BucketInput { name: "market".into(), cap: U128(20_000), max_per_grant: U128(20_000), once_per_account: false }],
        U128(0),
    );
    ctx("p1.players.testnet", STORAGE_DEPOSIT.as_yoctonear());
    assert!(c.storage_deposit(None));
    ctx("owner.testnet", 0);
    c.mt_mint(acc("p1.players.testnet"), vec![D.into()], vec![U128(100)], None);
    ctx("vault.testnet", 0);
    c.treasury_grant("market-1".into(), "market".into(), acc("ember.testnet"), U128(10_000), "NPC resource buying float".into());
    c
}

#[test]
fn mint_emits_nep245_event_and_supply() {
    let c = setup();
    assert_eq!(c.mt_balance_of(acc("lantern.testnet"), D.into()).0, 300);
    assert_eq!(c.mt_supply(D.into()).unwrap().0, 300);
    assert!(c.mt_supply("NOPE".into()).is_none());
    assert_eq!(c.mt_token(vec![D.into(), "NOPE".into()]).iter().filter(|t| t.is_some()).count(), 1);
}

#[test]
fn npc_transfer_moves_own_tokens_is_capped_and_idempotent() {
    let mut c = setup();
    ctx("lantern.testnet", 0); // function-call keys cannot attach deposits
    c.npc_transfer(acc("vault.testnet"), D.into(), U128(200), Some("trade".into()), "run1:trade_1".into());
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"standard\":\"nep245\"") && l.contains("\"event\":\"mt_transfer\"")));
    assert_eq!(c.mt_balance_of(acc("vault.testnet"), D.into()).0, 200);
    assert_eq!(c.mt_balance_of(acc("lantern.testnet"), D.into()).0, 100);
    assert_eq!(c.trade_status("run1:trade_1".into()).unwrap().amount.0, 200);
    assert!(c.trade_status("run1:other".into()).is_none());
}

#[test]
fn custodial_listing_escrows_resource_and_npc_fill_transfers_it_once() {
    let mut c = setup();
    ctx("lantern.testnet", 0);
    c.npc_transfer(acc("vault.testnet"), D.into(), U128(100), None, "purchase-1".into());
    ctx("vault.testnet", 0);
    c.custodial_list("player-1".into(), "listing-1".into(), D.into(), U128(60), U128(900));
    assert_eq!(c.mt_balance_of(acc("vault.testnet"), D.into()).0, 40);
    assert_eq!(c.mt_balance_of(acc("resources.testnet"), D.into()).0, 60);
    let listing = c.listing("listing-1".into()).unwrap();
    assert_eq!(listing.seller_id, "player-1");
    assert_eq!(listing.status, "active");

    ctx("vault.testnet", 0);
    c.custodial_fill_listing("listing-1".into(), acc("ember.testnet"));
    assert_eq!(c.mt_balance_of(acc("resources.testnet"), D.into()).0, 0);
    assert_eq!(c.mt_balance_of(acc("ember.testnet"), D.into()).0, 60);
    let listing = c.listing("listing-1".into()).unwrap();
    assert_eq!(listing.status, "filled");
    assert_eq!(listing.buyer_id, Some(acc("ember.testnet")));
}

#[test]
fn custodial_listing_can_only_be_created_by_operator_and_cancelled_once() {
    let mut c = setup();
    ctx("lantern.testnet", 0);
    c.npc_transfer(acc("vault.testnet"), D.into(), U128(100), None, "purchase-2".into());
    ctx("player.testnet", 0);
    let unauthorized = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.custodial_list("player-1".into(), "listing-2".into(), D.into(), U128(60), U128(900));
    }));
    assert!(unauthorized.is_err());

    ctx("vault.testnet", 0);
    c.custodial_list("player-1".into(), "listing-2".into(), D.into(), U128(60), U128(900));
    c.custodial_cancel_listing("listing-2".into());
    assert_eq!(c.mt_balance_of(acc("resources.testnet"), D.into()).0, 0);
    assert_eq!(c.mt_balance_of(acc("vault.testnet"), D.into()).0, 100);
    assert_eq!(c.listing("listing-2".into()).unwrap().status, "cancelled");
    let duplicate = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.custodial_cancel_listing("listing-2".into())));
    assert!(duplicate.is_err());
}

#[test]
fn listing_cannot_be_filled_by_non_npc_or_filled_twice() {
    let mut c = setup();
    ctx("lantern.testnet", 0);
    c.npc_transfer(acc("vault.testnet"), D.into(), U128(100), None, "purchase-3".into());
    ctx("vault.testnet", 0);
    c.custodial_list("player-1".into(), "listing-3".into(), D.into(), U128(60), U128(900));
    ctx("player.testnet", 0);
    let unauthorized = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.custodial_fill_listing("listing-3".into(), acc("ember.testnet"))));
    assert!(unauthorized.is_err());
    ctx("vault.testnet", 0);
    c.custodial_fill_listing("listing-3".into(), acc("ember.testnet"));
    let duplicate = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.custodial_fill_listing("listing-3".into(), acc("ember.testnet"))));
    assert!(duplicate.is_err());
}

#[test]
fn root_player_listing_escrows_owned_resources_and_atomically_pays_on_fill() {
    let mut c = setup_player_market();
    ctx("vault.testnet", 0);
    c.resource_listing_create(acc("p1.players.testnet"), "root-1".into(), D.into(), U128(40), U128(25));
    assert_eq!(c.mt_balance_of(acc("p1.players.testnet"), D.into()).0, 60);
    assert_eq!(c.mt_balance_of(acc("resources.testnet"), D.into()).0, 40);

    ctx("vault.testnet", 0);
    c.resource_listing_fill("root-1".into(), acc("ember.testnet"));
    assert_eq!(c.mt_balance_of(acc("resources.testnet"), D.into()).0, 0);
    assert_eq!(c.mt_balance_of(acc("ember.testnet"), D.into()).0, 40);
    assert_eq!(c.mt_balance_of(acc("p1.players.testnet"), CREDIT.into()).0, 1_000);
    assert_eq!(c.mt_balance_of(acc("ember.testnet"), CREDIT.into()).0, 9_000);
    let listing = c.listing("root-1".into()).unwrap();
    assert_eq!(listing.seller_id, "p1.players.testnet");
    assert_eq!(listing.status, "filled");
    assert_eq!(listing.buyer_id, Some(acc("ember.testnet")));
}

#[test]
fn root_player_listing_cancel_returns_resources_and_foreign_wallets_cannot_be_listed() {
    let mut c = setup_player_market();
    ctx("vault.testnet", 0);
    c.resource_listing_create(acc("p1.players.testnet"), "root-cancel".into(), D.into(), U128(20), U128(50));
    c.resource_listing_cancel("root-cancel".into());
    assert_eq!(c.mt_balance_of(acc("p1.players.testnet"), D.into()).0, 100);
    assert_eq!(c.mt_balance_of(acc("resources.testnet"), D.into()).0, 0);
    assert_eq!(c.listing("root-cancel".into()).unwrap().status, "cancelled");

    ctx("vault.testnet", 0);
    let foreign = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.resource_listing_create(acc("player.testnet"), "foreign".into(), D.into(), U128(1), U128(50));
    }));
    assert!(foreign.is_err());
    let duplicate_cancel = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resource_listing_cancel("root-cancel".into())));
    assert!(duplicate_cancel.is_err());
}

#[test]
#[should_panic(expected = "Trade already processed")]
fn duplicate_trade_id_is_rejected() {
    let mut c = setup();
    ctx("lantern.testnet", 0);
    c.npc_transfer(acc("vault.testnet"), D.into(), U128(10), None, "run1:trade_1".into());
    c.npc_transfer(acc("vault.testnet"), D.into(), U128(10), None, "run1:trade_1".into());
}

#[test]
#[should_panic(expected = "Amount exceeds NPC per-call cap")]
fn npc_cap_enforced() {
    let mut c = setup();
    ctx("lantern.testnet", 0);
    c.npc_transfer(acc("vault.testnet"), D.into(), U128(201), None, "t".into());
}

#[test]
#[should_panic(expected = "Caller is not a registered NPC")]
fn non_npc_cannot_use_npc_transfer() {
    let mut c = setup();
    ctx("player.testnet", 0);
    c.npc_transfer(acc("vault.testnet"), D.into(), U128(1), None, "t".into());
}

#[test]
#[should_panic(expected = "Insufficient balance")]
fn attacker_cannot_move_npc_tokens_with_mt_transfer() {
    let mut c = setup();
    ctx("player.testnet", 1);
    // the player holds 0 diesel; without an approval it can only move its own balance
    c.mt_transfer(acc("vault.testnet"), D.into(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "Not approved")]
fn attacker_cannot_claim_someone_elses_approval() {
    let mut c = setup();
    ctx("player.testnet", 1);
    c.mt_transfer(acc("player.testnet"), D.into(), U128(1), Some((acc("lantern.testnet"), 1)), None);
}

#[test]
#[should_panic(expected = "Receiver not registered for storage")]
fn unregistered_receiver_rejected() {
    let mut c = setup();
    ctx("lantern.testnet", 0);
    c.npc_transfer(acc("stranger.testnet"), D.into(), U128(1), None, "t".into());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn mt_transfer_requires_one_yocto() {
    let mut c = setup();
    ctx("lantern.testnet", 0);
    c.mt_transfer(acc("player.testnet"), D.into(), U128(1), None, None);
}

#[test]
fn approvals_allow_bounded_third_party_transfer() {
    let mut c = setup();
    ctx("lantern.testnet", 1);
    c.mt_approve(vec![D.into()], vec![U128(50)], acc("ember.testnet"), None);
    let a = c.mt_approval_of(acc("lantern.testnet"), D.into(), acc("ember.testnet")).unwrap();
    assert!(c.mt_is_approved(acc("lantern.testnet"), vec![D.into()], acc("ember.testnet"), vec![U128(50)], Some(vec![a.approval_id])));
    assert!(!c.mt_is_approved(acc("lantern.testnet"), vec![D.into()], acc("ember.testnet"), vec![U128(51)], None));
    ctx("ember.testnet", 1);
    c.mt_transfer(acc("player.testnet"), D.into(), U128(30), Some((acc("lantern.testnet"), a.approval_id)), None);
    assert_eq!(c.mt_balance_of(acc("player.testnet"), D.into()).0, 30);
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("\"authorized_id\":\"ember.testnet\"")));
    assert_eq!(c.mt_approval_of(acc("lantern.testnet"), D.into(), acc("ember.testnet")).unwrap().amount.0, 20);
}

#[test]
#[should_panic(expected = "Approved amount exceeded")]
fn approval_amount_is_a_hard_cap() {
    let mut c = setup();
    ctx("lantern.testnet", 1);
    c.mt_approve(vec![D.into()], vec![U128(5)], acc("ember.testnet"), None);
    let a = c.mt_approval_of(acc("lantern.testnet"), D.into(), acc("ember.testnet")).unwrap();
    ctx("ember.testnet", 1);
    c.mt_transfer(acc("player.testnet"), D.into(), U128(6), Some((acc("lantern.testnet"), a.approval_id)), None);
}

#[test]
#[should_panic(expected = "length mismatch")]
fn batch_length_mismatch_panics() {
    let mut c = setup();
    ctx("lantern.testnet", 1);
    c.mt_batch_transfer(acc("player.testnet"), vec![D.into()], vec![U128(1), U128(2)], None, None);
}

#[test]
fn settle_day_checks_consistency_and_burns_operator_custody() {
    let mut c = setup();
    ctx("lantern.testnet", 0);
    c.npc_transfer(acc("vault.testnet"), D.into(), U128(100), None, "t1".into());
    ctx("vault.testnet", 0);
    // 10 units = 1 L -> 2680 g CO2 -> needs 1 permit
    c.settle_day("run1".into(), 1, U128(10), U128(2_680), U128(1));
    assert_eq!(c.mt_balance_of(acc("vault.testnet"), D.into()).0, 90);
    assert_eq!(c.mt_supply(D.into()).unwrap().0, 290);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"mt_burn\"")));
    assert!(c.day_settlement("run1".into(), 1).is_some());
}

#[test]
#[should_panic(expected = "Retired permits do not cover CO2")]
fn settle_day_rejects_uncovered_co2() {
    let mut c = setup();
    ctx("vault.testnet", 0);
    c.settle_day("run1".into(), 1, U128(40), U128(10_720), U128(1));
}

#[test]
#[should_panic(expected = "Only the game operator")]
fn settle_day_operator_only() {
    let mut c = setup();
    ctx("player.testnet", 0);
    c.settle_day("run1".into(), 1, U128(0), U128(0), U128(0));
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_owner_mints() {
    let mut c = setup();
    ctx("player.testnet", 0);
    c.mt_mint(acc("player.testnet"), vec![D.into()], vec![U128(1_000)], None);
}

// ------------------------------------------------------------------ shared fuel exchange

const ALICE: &str = "alice.vault.testnet";
const BOB: &str = "bob.vault.testnet";
const HARBOR: &str = "harbor.testnet";
const NORTH: &str = "north.testnet";

fn ctx_at(pred: &str, deposit: u128, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("resources.testnet"))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts);
    testing_env!(b.build());
}

fn panics<F: FnOnce()>(f: F) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

/// Two traders (each capped at 1,000 units/day) and Alice holding 300 units on the exchange.
fn exchange_setup() -> Contract {
    let mut c = setup();
    for t in [HARBOR, NORTH] {
        ctx(t, STORAGE_DEPOSIT.as_yoctonear());
        assert!(c.storage_deposit(None));
    }
    ctx("owner.testnet", 0);
    c.register_trader(acc(HARBOR), U128(1_000));
    c.register_trader(acc(NORTH), U128(1_000));
    ctx(HARBOR, 0);
    c.npc_import(D.into(), U128(500), "harbor-import-1".into());
    ctx("vault.testnet", 0);
    c.exchange_deposit(acc(ALICE), D.into(), U128(300), "dep-1".into());
    c
}

fn bal(c: &Contract, a: &str) -> u128 {
    c.mt_balance_of(acc(a), D.into()).0
}

#[test]
fn exchange_player_ask_partially_filled_by_trader_then_bought_by_player() {
    let mut c = exchange_setup();
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"mt_mint\"") && l.contains("deposit:dep-1")));
    assert_eq!(bal(&c, ALICE), 300);

    ctx("vault.testnet", 0);
    c.exchange_ask(acc(ALICE), "ask-a".into(), D.into(), U128(200), U128(120));
    assert_eq!(bal(&c, ALICE), 100);
    assert_eq!(bal(&c, "resources.testnet"), 200);

    // the trader signs its own purchase with its function-call key (no deposit)
    ctx(HARBOR, 0);
    c.exchange_fill("ask-a".into(), acc(HARBOR), U128(120), "fill-1".into());
    let o = c.exchange_order("ask-a".into()).unwrap();
    assert_eq!((o.remaining.0, o.status.as_str()), (80, "open"));
    assert_eq!(bal(&c, HARBOR), 620);

    // the operator buys the rest for another player
    ctx("vault.testnet", 0);
    c.exchange_fill("ask-a".into(), acc(BOB), U128(80), "fill-2".into());
    let o = c.exchange_order("ask-a".into()).unwrap();
    assert_eq!((o.remaining.0, o.status.as_str()), (0, "filled"));
    assert_eq!(bal(&c, BOB), 80);
    let r = c.exchange_op("fill:fill-2".into()).unwrap();
    assert_eq!((r.account_id, r.counterparty_id, r.amount.0), (acc(BOB), Some(acc(ALICE)), 80));

    // Bob takes it home to his city tank: burned from the exchange
    c.exchange_redeem(acc(BOB), D.into(), U128(80), "red-1".into());
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"mt_burn\"") && l.contains("redeem:red-1")));
    assert_eq!(bal(&c, BOB), 0);
    // supply = lantern 300 (bootstrap) + harbor import 500 + alice deposit 300 - bob redeem 80
    assert_eq!(c.mt_supply(D.into()).unwrap().0, 300 + 500 + 300 - 80);
    assert_eq!(bal(&c, "lantern.testnet") + bal(&c, HARBOR) + bal(&c, ALICE) + bal(&c, BOB) + bal(&c, "resources.testnet"), 1_020);
}

#[test]
fn exchange_trader_ask_bought_by_player_and_cancelled_remainder_returns() {
    let mut c = exchange_setup();
    ctx(HARBOR, 0);
    c.exchange_ask(acc(HARBOR), "ask-h".into(), D.into(), U128(100), U128(110));
    ctx("vault.testnet", 0);
    c.exchange_fill("ask-h".into(), acc(BOB), U128(60), "fill-b".into());
    assert_eq!(bal(&c, BOB), 60);
    // the operator cannot cancel a trader's order
    assert!(panics(|| c.exchange_cancel("ask-h".into())));
    ctx(HARBOR, 0);
    c.exchange_cancel("ask-h".into());
    let o = c.exchange_order("ask-h".into()).unwrap();
    assert_eq!((o.remaining.0, o.status.as_str()), (0, "cancelled"));
    assert_eq!(bal(&c, HARBOR), 500 - 60);
    assert_eq!(bal(&c, "resources.testnet"), 0);
}

#[test]
fn exchange_operator_cannot_touch_trader_or_external_balances() {
    let mut c = exchange_setup();
    ctx("vault.testnet", 0);
    assert!(panics(|| c.exchange_ask(acc(HARBOR), "steal-1".into(), D.into(), U128(1), U128(1))));
    assert!(panics(|| c.exchange_deposit(acc("player.testnet"), D.into(), U128(1), "dep-x".into())));
    assert!(panics(|| c.exchange_deposit(acc("evilvault.testnet"), D.into(), U128(1), "dep-y".into())));
    assert!(panics(|| c.exchange_deposit(acc("vault.testnet"), D.into(), U128(1), "dep-z".into())));
    assert!(panics(|| c.exchange_redeem(acc(HARBOR), D.into(), U128(1), "red-x".into())));
    ctx(HARBOR, 0);
    c.exchange_ask(acc(HARBOR), "ask-h".into(), D.into(), U128(50), U128(110));
    ctx("vault.testnet", 0);
    // the operator may buy only for player ids, never route a trader's escrow to a trader or to itself
    assert!(panics(|| c.exchange_fill("ask-h".into(), acc(NORTH), U128(10), "f-1".into())));
    assert!(panics(|| c.exchange_fill("ask-h".into(), acc("vault.testnet"), U128(10), "f-2".into())));
    assert_eq!(bal(&c, HARBOR), 450);
}

#[test]
fn exchange_trader_acts_only_for_itself() {
    let mut c = exchange_setup();
    ctx(HARBOR, 0);
    assert!(panics(|| c.exchange_ask(acc(ALICE), "a-1".into(), D.into(), U128(10), U128(100))));
    ctx("vault.testnet", 0);
    c.exchange_ask(acc(ALICE), "ask-a".into(), D.into(), U128(50), U128(100));
    ctx(HARBOR, 0);
    assert!(panics(|| c.exchange_fill("ask-a".into(), acc(NORTH), U128(10), "f-n".into())));
    assert!(panics(|| c.exchange_cancel("ask-a".into())));
    // an unregistered account cannot use trader methods
    ctx("player.testnet", 0);
    assert!(panics(|| c.npc_import(D.into(), U128(1), "imp-x".into())));
    assert!(panics(|| c.exchange_fill("ask-a".into(), acc("player.testnet"), U128(1), "f-p".into())));
}

#[test]
fn exchange_ids_are_single_use_and_escrow_cannot_be_sold_twice() {
    let mut c = exchange_setup();
    ctx("vault.testnet", 0);
    assert!(panics(|| c.exchange_deposit(acc(ALICE), D.into(), U128(1), "dep-1".into())));
    c.exchange_ask(acc(ALICE), "ask-a".into(), D.into(), U128(100), U128(100));
    assert!(panics(|| c.exchange_ask(acc(ALICE), "ask-a".into(), D.into(), U128(1), U128(100))));
    // Alice has 200 left; she cannot escrow more than she holds
    assert!(panics(|| c.exchange_ask(acc(ALICE), "ask-b".into(), D.into(), U128(201), U128(100))));
    ctx(HARBOR, 0);
    assert!(panics(|| c.exchange_fill("ask-a".into(), acc(HARBOR), U128(101), "f-over".into())));
    c.exchange_fill("ask-a".into(), acc(HARBOR), U128(100), "f-1".into());
    assert!(panics(|| c.exchange_fill("ask-a".into(), acc(HARBOR), U128(1), "f-2".into())));
    ctx(NORTH, 0);
    assert!(panics(|| c.exchange_fill("ask-a".into(), acc(NORTH), U128(1), "f-1".into())));
    // a filled order cannot be cancelled back to the seller
    ctx("vault.testnet", 0);
    assert!(panics(|| c.exchange_cancel("ask-a".into())));
    assert_eq!(bal(&c, ALICE), 200);
    assert_eq!(bal(&c, HARBOR), 600);
}

#[test]
fn exchange_cannot_buy_own_order() {
    let mut c = exchange_setup();
    ctx(HARBOR, 0);
    c.exchange_ask(acc(HARBOR), "ask-h".into(), D.into(), U128(10), U128(100));
    assert!(panics(|| c.exchange_fill("ask-h".into(), acc(HARBOR), U128(5), "f-self".into())));
}

#[test]
fn trader_imports_are_capped_per_day() {
    let mut c = exchange_setup(); // HARBOR imported 500 on day 0
    ctx_at(HARBOR, 0, 1_000);
    c.npc_import(D.into(), U128(500), "imp-2".into());
    assert!(panics(|| c.npc_import(D.into(), U128(1), "imp-3".into())));
    assert!(panics(|| c.npc_import(D.into(), U128(1), "imp-2".into())));
    ctx_at(HARBOR, 0, NANOS_PER_DAY + 1);
    c.npc_import(D.into(), U128(1_000), "imp-4".into());
    assert_eq!(bal(&c, HARBOR), 2_000);
    // only the owner registers traders, never as the operator or a player id
    ctx("vault.testnet", 0);
    assert!(panics(|| c.register_trader(acc("lantern.testnet"), U128(1))));
    ctx("owner.testnet", 0);
    assert!(panics(|| c.register_trader(acc("vault.testnet"), U128(1))));
    assert!(panics(|| c.register_trader(acc(ALICE), U128(1))));
    assert_eq!(c.trader_config(acc(HARBOR)).unwrap().max_import_per_day.0, 1_000);
    assert_eq!(c.player_namespace(), ".vault.testnet");
}

#[test]
fn revoke_all_clears_approvals() {
    let mut c = setup();
    ctx("lantern.testnet", 1);
    c.mt_approve(vec![D.into()], vec![U128(50)], acc("player.testnet"), None);
    assert!(c.mt_is_approved(acc("lantern.testnet"), vec![D.into()], acc("player.testnet"), vec![U128(50)], None));
    c.mt_revoke_all(vec![D.into()]);
    assert!(!c.mt_is_approved(acc("lantern.testnet"), vec![D.into()], acc("player.testnet"), vec![U128(1)], None));
}

#[test]
fn self_custody_removes_operator_power_but_not_before_offers_close() {
    let mut c = exchange_setup(); // Alice holds 300 on the exchange
    ctx("vault.testnet", 0);
    c.exchange_ask(acc(ALICE), "ask-a".into(), D.into(), U128(100), U128(100));
    // Alice's account now exists with her own key; she cannot leave with an open offer
    ctx(ALICE, 0);
    assert!(panics(|| c.release_to_owner()));
    ctx("vault.testnet", 0);
    c.exchange_cancel("ask-a".into());
    ctx(ALICE, 0);
    c.release_to_owner();
    assert!(c.is_released(acc(ALICE)));
    // the operator has no power over her id any more
    ctx("vault.testnet", 0);
    assert!(panics(|| c.exchange_ask(acc(ALICE), "ask-b".into(), D.into(), U128(1), U128(100))));
    assert!(panics(|| c.exchange_redeem(acc(ALICE), D.into(), U128(1), "red-z".into())));
    assert!(panics(|| c.exchange_deposit(acc(ALICE), D.into(), U128(1), "dep-z".into())));
    // she moves her own tokens like any NEP-245 holder
    ctx(ALICE, 1);
    c.mt_transfer(acc(HARBOR), D.into(), U128(50), None, None);
    assert_eq!(bal(&c, ALICE), 250);
    // outsiders and traders cannot release anyone
    ctx(HARBOR, 0);
    assert!(panics(|| c.release_to_owner()));
    ctx(BOB, 0);
    c.release_to_owner(); // Bob has no offers and no balance: releasing is allowed and harmless
    assert!(c.is_released(acc(BOB)));
}

#[test]
fn filled_offers_close_for_self_custody_purposes() {
    let mut c = exchange_setup();
    ctx("vault.testnet", 0);
    c.exchange_ask(acc(ALICE), "ask-a".into(), D.into(), U128(100), U128(100));
    ctx(HARBOR, 0);
    c.exchange_fill("ask-a".into(), acc(HARBOR), U128(100), "f-1".into());
    ctx(ALICE, 0);
    c.release_to_owner();
    assert!(c.is_released(acc(ALICE)));
}

#[test]
fn trader_supplies_city_merchants_from_its_own_wallet_once() {
    let mut c = exchange_setup(); // HARBOR holds 500
    ctx(HARBOR, 0);
    c.npc_supply_city(D.into(), U128(120), "sup-1".into());
    assert_eq!(bal(&c, HARBOR), 380);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"mt_burn\"") && l.contains("supply:sup-1")));
    assert!(panics(|| c.npc_supply_city(D.into(), U128(1), "sup-1".into())));
    assert!(panics(|| c.npc_supply_city(D.into(), U128(10_000), "sup-2".into())));
    // nobody else can make a trader supply, and the operator cannot either
    ctx("vault.testnet", 0);
    assert!(panics(|| c.npc_supply_city(D.into(), U128(1), "sup-3".into())));
    assert_eq!(c.exchange_op("supply:sup-1".into()).unwrap().amount.0, 120);
}
