#[cfg(test)]
mod tests {
    use super::super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup_test() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        let admin = Address::random(&env);
        let sxlm_token = Address::random(&env);
        let native_token = Address::random(&env);
        let user = Address::random(&env);

        (env, admin, sxlm_token, native_token, user)
    }

    #[test]
    fn test_initialize_lp_pool() {
        let (env, admin, sxlm, native, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);
        // Verify initialization
    }

    #[test]
    fn test_add_liquidity() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        let lp_minted = client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);
        assert!(lp_minted > 0);

        let lp_balance = client.get_lp_balance(&user);
        assert_eq!(lp_balance, lp_minted);
    }

    #[test]
    fn test_remove_liquidity() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        let lp_minted = client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);
        let (xlm_out, sxlm_out) = client.remove_liquidity(&user, &(lp_minted / 2));

        assert!(xlm_out > 0);
        assert!(sxlm_out > 0);
    }

    #[test]
    fn test_swap_xlm_to_sxlm() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);
        client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);

        let sxlm_out = client.swap_xlm_to_sxlm(&user, &100_0000000, &50_0000000);
        assert!(sxlm_out > 0);
        assert!(sxlm_out >= 50_0000000);
    }

    #[test]
    fn test_swap_sxlm_to_xlm() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);
        client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);

        let xlm_out = client.swap_sxlm_to_xlm(&user, &100_0000000, &50_0000000);
        assert!(xlm_out > 0);
        assert!(xlm_out >= 50_0000000);
    }

    #[test]
    fn test_get_reserves() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        let (xlm_before, sxlm_before) = client.get_reserves();
        assert_eq!(xlm_before, 0);
        assert_eq!(sxlm_before, 0);

        client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);

        let (xlm_after, sxlm_after) = client.get_reserves();
        assert_eq!(xlm_after, 1_000_0000000);
        assert_eq!(sxlm_after, 1_000_0000000);
    }

    #[test]
    fn test_get_price() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);

        let price = client.get_price();
        assert!(price > 0);
    }

    #[test]
    fn test_set_mining_program() {
        let (env, admin, sxlm, native, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);
        let reward_asset = Address::random(&env);

        client.initialize(&admin, &sxlm, &native);

        let program = MiningProgramData {
            reward_asset: reward_asset.clone(),
            reward_per_second: 1_000_000,
            total_rewards: 10_000_0000000,
            distributed_rewards: 0,
            start_time: 1_000_000,
            end_time: 2_000_000,
        };

        client.set_mining_program(&program);
    }

    #[test]
    fn test_pending_rewards() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);
        let reward_asset = Address::random(&env);

        client.initialize(&admin, &sxlm, &native);

        let program = MiningProgramData {
            reward_asset: reward_asset.clone(),
            reward_per_second: 1_000_000,
            total_rewards: 10_000_0000000,
            distributed_rewards: 0,
            start_time: 1_000_000,
            end_time: 2_000_000,
        };

        client.set_mining_program(&program);
        client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);

        let pending = client.pending_rewards(&user);
        assert!(pending >= 0);
    }

    #[test]
    fn test_claim_rewards() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);
        let reward_asset = Address::random(&env);

        client.initialize(&admin, &sxlm, &native);

        let program = MiningProgramData {
            reward_asset: reward_asset.clone(),
            reward_per_second: 1_000_000,
            total_rewards: 10_000_0000000,
            distributed_rewards: 0,
            start_time: 1_000_000,
            end_time: 2_000_000,
        };

        client.set_mining_program(&program);
        client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);

        let rewards_claimed = client.claim_rewards(&user);
        assert!(rewards_claimed >= 0);
    }

    #[test]
    fn test_total_lp_supply() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        let supply_before = client.total_lp_supply();
        assert_eq!(supply_before, 0);

        let lp_minted = client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);

        let supply_after = client.total_lp_supply();
        assert_eq!(supply_after, lp_minted);
    }

    #[test]
    fn test_collect_protocol_fees() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);
        client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);

        // Swap to generate fees
        client.swap_xlm_to_sxlm(&user, &100_0000000, &10_0000000);

        let fees = client.collect_protocol_fees();
        assert!(fees >= 0);
    }

    #[test]
    fn test_set_protocol_fee_bps() {
        let (env, admin, sxlm, native, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);

        client.set_protocol_fee_bps(&50);

        let fee_bps = client.protocol_fee_bps();
        assert_eq!(fee_bps, 50);
    }

    #[test]
    fn test_accrued_protocol_fees() {
        let (env, admin, sxlm, native, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm, &native);
        client.add_liquidity(&user, &1_000_0000000, &1_000_0000000);

        let accrued = client.accrued_protocol_fees();
        assert!(accrued >= 0);
    }
}
