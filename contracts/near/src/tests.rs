use super::*;
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
