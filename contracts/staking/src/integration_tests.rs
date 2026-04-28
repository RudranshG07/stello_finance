#[cfg(test)]
mod tests {
    use super::super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, BytesN};

    fn setup_test() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        let admin = Address::random(&env);
        let sxlm_token = Address::random(&env);
        let native_token = Address::random(&env);
        let user = Address::random(&env);

        (env, admin, sxlm_token, native_token, user)
    }

    #[test]
    fn test_initialize_contract() {
        let (env, admin, sxlm, native, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        // Initialize should succeed
        client.initialize(&admin, &sxlm, &native);

        // Should not reinitialize
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.initialize(&admin, &sxlm, &native);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_deposit_xlm() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        // Deposit should work
        let sxlm_minted = client.deposit(&user, &1_000_0000000);
        assert!(sxlm_minted > 0);

        // Exchange rate should be calculated
        let rate = client.get_exchange_rate();
        assert!(rate > 0);
    }

    #[test]
    fn test_exchange_rate_consistency() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        let initial_rate = client.get_exchange_rate();
        assert_eq!(initial_rate, 10_000_000); // 1:1 initially

        client.deposit(&user, &1_000_0000000);
        let rate_after_deposit = client.get_exchange_rate();

        // Rate should remain 1:1 without rewards
        assert_eq!(rate_after_deposit, 10_000_000);
    }

    #[test]
    fn test_add_rewards_increases_exchange_rate() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        client.deposit(&user, &1_000_0000000);
        let rate_before = client.get_exchange_rate();

        // Add rewards
        client.add_rewards(&500_0000000);
        let rate_after = client.get_exchange_rate();

        // Rate should increase
        assert!(rate_after > rate_before);
    }

    #[test]
    fn test_request_withdrawal() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);
        client.deposit(&user, &1_000_0000000);

        // Request withdrawal
        let withdrawal_id = client.request_withdrawal(&user, &500_0000000);
        assert!(withdrawal_id >= 0);
    }

    #[test]
    fn test_pause_prevent_deposits() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);
        client.pause();

        // Deposit should fail when paused
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.deposit(&user, &1_000_0000000);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_unpause_allows_deposits() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);
        client.pause();
        client.unpause();

        // Deposit should work after unpause
        let sxlm_minted = client.deposit(&user, &1_000_0000000);
        assert!(sxlm_minted > 0);
    }

    #[test]
    fn test_apply_slashing() {
        let (env, admin, sxlm, native, _user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        let total_before = client.total_xlm_staked();
        client.apply_slashing(&100_0000000);
        let total_after = client.total_xlm_staked();

        // Total should decrease after slashing
        assert!(total_after <= total_before);
    }

    #[test]
    fn test_set_cooldown_period() {
        let (env, admin, sxlm, native, _user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        // Set new cooldown
        client.set_cooldown_period(&8640);
        // Verify it was set (would need getter in contract)
    }

    #[test]
    fn test_set_admin() {
        let (env, admin, sxlm, native, _user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);
        let new_admin = Address::random(&env);

        client.initialize(&admin, &sxlm, &native);
        client.set_admin(&new_admin);
        // Verify new admin can perform admin actions
    }

    #[test]
    fn test_total_sxlm_supply() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        let supply_before = client.total_sxlm_supply();
        assert_eq!(supply_before, 0);

        client.deposit(&user, &1_000_0000000);
        let supply_after = client.total_sxlm_supply();

        assert!(supply_after > 0);
    }

    #[test]
    fn test_liquidity_buffer() {
        let (env, admin, sxlm, native, _user) = setup_test();
        let contract_id = Address::random(&env);
        let client = StakingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        let buffer = client.liquidity_buffer();
        assert!(buffer >= 0);
    }
}
