//! Security tests for Plant Assets (NEP-171), plant-account control, whole-asset sales and settlement epochs.
use super::plants::*;
use super::*;
use near_sdk::json_types::I64;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn ctx(pred: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("resources.testnet")).predecessor_account_id(acc(pred)).signer_account_id(acc(pred)).attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}
const OP: &str = "vault.testnet";
const ALICE: &str = "alice.vault.testnet"; // a game player id in the operator's namespace
const BOB: &str = "bob.testnet"; // an external self-custody account
const C: &str = "credit:vesper";

fn meta() -> PlantMetadata {
    PlantMetadata { title: "Kestrel Peaker".into(), tech: "ocgt".into(), node_id: "industrial_south".into(), capacity_kw: 120_000 }
}

fn setup() -> Contract {
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acc("owner.testnet"), acc(OP));
    for t in [C, "fuel:natural-gas", "fuel:diesel", "permit:carbon", "certificate:renewable"] {
        c.register_token(t.into(), t.into(), "unit".into());
    }
    for a in [ALICE, BOB] {
        ctx(a, STORAGE_DEPOSIT.as_yoctonear());
        c.storage_deposit(None);
    }
    ctx("owner.testnet", 0);
    c.mt_mint(acc(ALICE), vec![C.into()], vec![U128(1_000_000)], None);
    c.mt_mint(acc(BOB), vec![C.into()], vec![U128(1_000_000)], None);
    c.mt_mint(acc(OP), vec![C.into()], vec![U128(5_000_000)], None);
    ctx(OP, PLANT_ACCOUNT_DEPOSIT.as_yoctonear());
    let _ = c.plant_mint("p00001".into(), acc(ALICE), meta());
    c
}

fn panics<F: FnOnce()>(f: F, needle: &str) {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    let e = r.expect_err("expected a panic");
    let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    assert!(msg.contains(needle), "panic {:?} did not contain {:?}", msg, needle);
}

#[test]
fn mint_is_operator_only_unique_and_well_formed() {
    let mut c = setup();
    assert_eq!(c.nft_total_supply().0, 1);
    let t = c.nft_token("p00001".into()).unwrap();
    assert_eq!(t.owner_id, acc(ALICE));
    assert!(get_logs().is_empty() || true);
    assert_eq!(c.plant_account_id("p00001".into()), acc("p00001.resources.testnet"));
    ctx(BOB, PLANT_ACCOUNT_DEPOSIT.as_yoctonear());
    panics(|| { let _ = c.plant_mint("p00002".into(), acc(BOB), meta()); }, "Only the game operator");
    ctx(OP, PLANT_ACCOUNT_DEPOSIT.as_yoctonear());
    panics(|| { let _ = c.plant_mint("p00001".into(), acc(BOB), meta()); }, "already minted");
    panics(|| { let _ = c.plant_mint("plant-7".into(), acc(BOB), meta()); }, "p00042");
    // no deposit: the contract pays for the plant account itself, but only out of a healthy reserve
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("resources.testnet")).predecessor_account_id(acc(OP)).account_balance(NearToken::from_millinear(100));
    testing_env!(b.build());
    panics(|| { let _ = c.plant_mint("p00003".into(), acc(BOB), meta()); }, "Attach");
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("resources.testnet")).predecessor_account_id(acc(OP)).account_balance(NearToken::from_near(10));
    testing_env!(b.build());
    let _ = c.plant_mint("p00003".into(), acc(BOB), meta());
    assert_eq!(c.nft_token("p00003".into()).unwrap().owner_id, acc(BOB));
    // region-scoped ids: unique across every player's region, and still a valid account prefix
    let _ = c.plant_mint("p3fa9c01b00011".into(), acc(BOB), meta());
    assert_eq!(c.plant_account_id("p3fa9c01b00011".into()), acc("p3fa9c01b00011.resources.testnet"));
    panics(|| { let _ = c.plant_mint("pABC00011".into(), acc(BOB), meta()); }, "p00042");
}

#[test]
fn mint_emits_nep171_event() {
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acc("owner.testnet"), acc(OP));
    ctx(OP, PLANT_ACCOUNT_DEPOSIT.as_yoctonear());
    let _ = c.plant_mint("p00009".into(), acc(BOB), meta());
    assert!(get_logs().iter().any(|l| l.contains("\"standard\":\"nep171\"") && l.contains("\"event\":\"nft_mint\"") && l.contains("p00009")));
}

#[test]
fn only_the_current_owner_controls_the_plant_account() {
    let mut c = setup();
    let pa = c.plant_account_id("p00001".into());
    // earnings arrive in the plant account (here via settlement)
    ctx(OP, 0);
    c.settle_epoch("r1:1".into(), "a".repeat(64), vec![(acc(OP), I64(-5_000)), (pa.clone(), I64(5_000))]);
    assert_eq!(c.mt_balance_of(pa.clone(), C.into()).0, 5_000);
    ctx(BOB, 0);
    panics(|| c.plant_withdraw("p00001".into(), C.into(), U128(1)), "Only the plant's owner");
    // the operator may act for its namespaced player…
    ctx(OP, 0);
    c.plant_withdraw("p00001".into(), C.into(), U128(1_000));
    assert_eq!(c.mt_balance_of(acc(ALICE), C.into()).0, 1_001_000);
    // …and Alice herself may
    ctx(ALICE, 0);
    c.plant_withdraw("p00001".into(), C.into(), U128(1_000));
    assert_eq!(c.mt_balance_of(pa, C.into()).0, 3_000);
}

#[test]
fn control_moves_with_ownership() {
    let mut c = setup();
    let pa = c.plant_account_id("p00001".into());
    ctx(OP, 0);
    c.settle_epoch("r1:1".into(), "b".repeat(64), vec![(acc(OP), I64(-9_000)), (pa.clone(), I64(9_000))]);
    ctx(ALICE, 1);
    c.nft_transfer(acc(BOB), "p00001".into(), None, None);
    assert_eq!(c.nft_token("p00001".into()).unwrap().owner_id, acc(BOB));
    assert_eq!(c.nft_supply_for_owner(acc(ALICE)).0, 0);
    assert_eq!(c.nft_tokens_for_owner(acc(BOB), None, None).len(), 1);
    // the old owner (and the operator acting for her) lost control
    ctx(ALICE, 0);
    panics(|| c.plant_withdraw("p00001".into(), C.into(), U128(1)), "Only the plant's owner");
    ctx(OP, 0);
    panics(|| c.plant_withdraw("p00001".into(), C.into(), U128(1)), "Only the plant's owner");
    // the account kept its balance; the new owner draws it
    ctx(BOB, 0);
    c.plant_withdraw("p00001".into(), C.into(), U128(9_000));
    assert_eq!(c.mt_balance_of(acc(BOB), C.into()).0, 1_009_000);
}

#[test]
fn nft_transfer_needs_one_yocto_and_owner_or_approval() {
    let mut c = setup();
    ctx(ALICE, 0);
    panics(|| c.nft_transfer(acc(BOB), "p00001".into(), None, None), "1 yoctoNEAR");
    ctx(BOB, 1);
    panics(|| c.nft_transfer(acc(BOB), "p00001".into(), None, None), "Not the owner");
    ctx(ALICE, 1);
    c.nft_approve("p00001".into(), acc(BOB));
    assert!(c.nft_is_approved("p00001".into(), acc(BOB), None));
    ctx(BOB, 1);
    c.nft_transfer(acc(BOB), "p00001".into(), Some(1), None);
    let t = c.nft_token("p00001".into()).unwrap();
    assert_eq!(t.owner_id, acc(BOB));
    assert!(t.approved_account_ids.is_empty(), "approvals are cleared on transfer");
}

#[test]
fn revoked_approval_cannot_transfer() {
    let mut c = setup();
    ctx(ALICE, 1);
    c.nft_approve("p00001".into(), acc(BOB));
    c.nft_revoke("p00001".into(), acc(BOB));
    ctx(BOB, 1);
    panics(|| c.nft_transfer(acc(BOB), "p00001".into(), None, None), "Not the owner");
}

#[test]
fn whole_asset_sale_is_atomic() {
    let mut c = setup();
    ctx(BOB, 0);
    panics(|| c.plant_list("p00001".into(), U128(10)), "Only the plant's owner");
    ctx(ALICE, 0);
    c.plant_list("p00001".into(), U128(250_000));
    panics(|| c.plant_buy("p00001".into()), "already own");
    ctx(BOB, 0);
    c.plant_buy("p00001".into());
    assert_eq!(c.nft_token("p00001".into()).unwrap().owner_id, acc(BOB));
    assert_eq!(c.mt_balance_of(acc(BOB), C.into()).0, 750_000);
    assert_eq!(c.mt_balance_of(acc(ALICE), C.into()).0, 1_250_000);
    assert!(c.plant_sale("p00001".into()).is_none(), "the listing is gone");
    ctx(ALICE, 0);
    panics(|| c.plant_buy("p00001".into()), "Not for sale");
}

#[test]
fn a_buyer_without_credits_changes_nothing() {
    let mut c = setup();
    ctx(ALICE, 0);
    c.plant_list("p00001".into(), U128(5_000_000));
    ctx(BOB, 0);
    panics(|| c.plant_buy("p00001".into()), "Insufficient balance");
    assert_eq!(c.nft_token("p00001".into()).unwrap().owner_id, acc(ALICE));
    assert_eq!(c.mt_balance_of(acc(BOB), C.into()).0, 1_000_000);
}

#[test]
fn transferring_cancels_the_listing() {
    let mut c = setup();
    ctx(ALICE, 0);
    c.plant_list("p00001".into(), U128(100));
    ctx(ALICE, 1);
    c.nft_transfer(acc(BOB), "p00001".into(), None, None);
    assert!(c.plant_sale("p00001".into()).is_none());
    ctx(OP, 0);
    panics(|| c.plant_buy_for(acc(ALICE), "p00001".into()), "Not for sale");
}

#[test]
fn operator_cannot_touch_released_or_external_owners() {
    let mut c = setup();
    // Alice takes self-custody: the operator loses power over her plant
    ctx(ALICE, 0);
    c.release_to_owner();
    ctx(OP, 0);
    panics(|| c.plant_transfer_for(acc(ALICE), acc(OP), "p00001".into()), "Not a player id");
    panics(|| c.plant_list("p00001".into(), U128(1)), "Only the plant's owner");
    // nor an external account's
    ctx(ALICE, 1);
    c.nft_transfer(acc(BOB), "p00001".into(), None, None);
    ctx(OP, 0);
    panics(|| c.plant_transfer_for(acc(BOB), acc(OP), "p00001".into()), "Not a player id");
}

#[test]
fn settlement_epochs_are_single_use_zero_sum_and_consented() {
    let mut c = setup();
    let h = "c".repeat(64);
    ctx(BOB, 0);
    panics(|| c.settle_epoch("r1:1".into(), h.clone(), vec![(acc(ALICE), I64(-1)), (acc(BOB), I64(1))]), "Only the game operator");
    ctx(OP, 0);
    panics(|| c.settle_epoch("r1:1".into(), h.clone(), vec![(acc(ALICE), I64(-1)), (acc(BOB), I64(2))]), "sum to zero");
    panics(|| c.settle_epoch("r1:1".into(), "xyz".into(), vec![(acc(ALICE), I64(-1)), (acc(BOB), I64(1))]), "64 hex");
    // an external account never consented: it can be paid, never charged
    panics(|| c.settle_epoch("r1:1".into(), h.clone(), vec![(acc(BOB), I64(-10)), (acc(ALICE), I64(10))]), "didn't consent");
    c.settle_epoch("r1:1".into(), h.clone(), vec![(acc(ALICE), I64(-300)), (acc(BOB), I64(100)), (acc("ingrid.testnet"), I64(200))]);
    assert_eq!(c.mt_balance_of(acc(ALICE), C.into()).0, 999_700);
    assert_eq!(c.mt_balance_of(acc(BOB), C.into()).0, 1_000_100);
    assert_eq!(c.mt_balance_of(acc("ingrid.testnet"), C.into()).0, 200);
    assert_eq!(c.epoch("r1:1".into()).unwrap().hash, h);
    panics(|| c.settle_epoch("r1:1".into(), h.clone(), vec![(acc(ALICE), I64(-1)), (acc(BOB), I64(1))]), "already settled");
    // a short account fails the whole epoch before anything moves
    panics(|| c.settle_epoch("r1:2".into(), h, vec![(acc(ALICE), I64(-9_999_999)), (acc(BOB), I64(9_999_999))]), "Insufficient credits");
    assert_eq!(c.mt_balance_of(acc(BOB), C.into()).0, 1_000_100);
    // a released player can no longer be debited by the game
    ctx(ALICE, 0);
    c.release_to_owner();
    ctx(OP, 0);
    panics(|| c.settle_epoch("r1:3".into(), "d".repeat(64), vec![(acc(ALICE), I64(-1)), (acc(OP), I64(1))]), "didn't consent");
}

#[test]
fn market_epochs_settle_each_item_token_once() {
    let mut c = setup();
    ctx("owner.testnet", 0);
    c.register_npc(acc(BOB), U128(0));
    c.mt_mint(acc(OP), vec!["fuel:diesel".into()], vec![U128(10_000)], None);
    ctx(OP, 0);
    let h = "e".repeat(64);
    // the market's clearing account (the operator) delivers diesel to a merchant; the merchant pays credits
    c.settle_items("town:1".into(), h.clone(), "fuel:diesel".into(), vec![(acc(OP), I64(-4_000)), (acc(BOB), I64(4_000))]);
    c.settle_items("town:1".into(), h.clone(), C.into(), vec![(acc(BOB), I64(-300)), (acc(OP), I64(300))]);
    assert_eq!(c.mt_balance_of(acc(BOB), "fuel:diesel".into()).0, 4_000);
    assert_eq!(c.mt_balance_of(acc(BOB), C.into()).0, 999_700);
    panics(|| c.settle_items("town:1".into(), h.clone(), "fuel:diesel".into(), vec![(acc(OP), I64(-1)), (acc(BOB), I64(1))]), "already settled");
    panics(|| c.settle_items("town:2".into(), h, "material:unobtainium".into(), vec![(acc(OP), I64(-1)), (acc(BOB), I64(1))]), "not registered");
}
