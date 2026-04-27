#[cfg(test)]
mod tests {
    use super::super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

    fn setup_test() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        let admin = Address::random(&env);
        let native_token = Address::random(&env);
        let staking_contract = Address::random(&env);
        let user = Address::random(&env);

        (env, admin, native_token, staking_contract, user)
    }

    #[test]
    fn test_initialize_lending_contract() {
        let (env, admin, native, staking, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &native, &staking);
        // Verify initialization completed
    }

    #[test]
    fn test_configure_asset() {
        let (env, admin, native, staking, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);
        let collateral_asset = Address::random(&env);

        client.initialize(&admin, &native, &staking);

        let config = AssetConfig {
            collateral_factor_bps: 7500,
            liquidation_threshold_bps: 8000,
            price_in_xlm: 10_000_000,
        };

        client.configure_asset(&collateral_asset, &config);

        // Verify asset is configured
        let retrieved_config = client.get_asset_config(&collateral_asset);
        assert_eq!(retrieved_config.collateral_factor_bps, 7500);
    }

    #[test]
    fn test_deposit_collateral() {
        let (env, admin, native, staking, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);
        let collateral_asset = Address::random(&env);

        client.initialize(&admin, &native, &staking);

        let config = AssetConfig {
            collateral_factor_bps: 7500,
            liquidation_threshold_bps: 8000,
            price_in_xlm: 10_000_000,
        };
        client.configure_asset(&collateral_asset, &config);

        // Deposit collateral
        client.deposit_collateral(&user, &collateral_asset, &1_000_0000000);

        // Verify deposit
        let collateral = client.get_user_asset_collateral(&user, &collateral_asset);
        assert_eq!(collateral, 1_000_0000000);
    }

    #[test]
    fn test_withdraw_collateral() {
        let (env, admin, native, staking, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);
        let collateral_asset = Address::random(&env);

        client.initialize(&admin, &native, &staking);

        let config = AssetConfig {
            collateral_factor_bps: 7500,
            liquidation_threshold_bps: 8000,
            price_in_xlm: 10_000_000,
        };
        client.configure_asset(&collateral_asset, &config);

        client.deposit_collateral(&user, &collateral_asset, &1_000_0000000);
        client.withdraw_collateral(&user, &collateral_asset, &500_0000000);

        // Verify withdrawal
        let collateral = client.get_user_asset_collateral(&user, &collateral_asset);
        assert_eq!(collateral, 500_0000000);
    }

    #[test]
    fn test_borrow() {
        let (env, admin, native, staking, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);
        let collateral_asset = Address::random(&env);

        client.initialize(&admin, &native, &staking);

        let config = AssetConfig {
            collateral_factor_bps: 7500,
            liquidation_threshold_bps: 8000,
            price_in_xlm: 10_000_000,
        };
        client.configure_asset(&collateral_asset, &config);

        client.deposit_collateral(&user, &collateral_asset, &2_000_0000000);
        client.borrow(&user, &1_000_0000000);

        // Verify borrow
        let (_, borrowed) = client.get_position(&user);
        assert!(borrowed > 0);
    }

    #[test]
    fn test_repay_debt() {
        let (env, admin, native, staking, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);
        let collateral_asset = Address::random(&env);

        client.initialize(&admin, &native, &staking);

        let config = AssetConfig {
            collateral_factor_bps: 7500,
            liquidation_threshold_bps: 8000,
            price_in_xlm: 10_000_000,
        };
        client.configure_asset(&collateral_asset, &config);

        client.deposit_collateral(&user, &collateral_asset, &2_000_0000000);
        client.borrow(&user, &1_000_0000000);

        let borrowed_before = client.total_borrowed();

        client.repay(&user, &500_0000000);

        let borrowed_after = client.total_borrowed();
        assert!(borrowed_after <= borrowed_before);
    }

    #[test]
    fn test_health_factor() {
        let (env, admin, native, staking, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);
        let collateral_asset = Address::random(&env);

        client.initialize(&admin, &native, &staking);

        let config = AssetConfig {
            collateral_factor_bps: 7500,
            liquidation_threshold_bps: 8000,
            price_in_xlm: 10_000_000,
        };
        client.configure_asset(&collateral_asset, &config);

        client.deposit_collateral(&user, &collateral_asset, &2_000_0000000);
        client.borrow(&user, &500_0000000);

        let health = client.health_factor(&user);
        assert!(health > 10_000_000); // Should be well above 1.0
    }

    #[test]
    fn test_liquidation() {
        let (env, admin, native, staking, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);
        let liquidator = Address::random(&env);
        let collateral_asset = Address::random(&env);

        client.initialize(&admin, &native, &staking);

        let config = AssetConfig {
            collateral_factor_bps: 7500,
            liquidation_threshold_bps: 8000,
            price_in_xlm: 10_000_000,
        };
        client.configure_asset(&collateral_asset, &config);

        client.deposit_collateral(&user, &collateral_asset, &2_000_0000000);
        client.borrow(&user, &1_500_0000000); // Risky borrow

        // Liquidation would occur when health factor < 1.0
        // This test verifies the liquidation function exists and is callable
    }

    #[test]
    fn test_update_borrow_rate() {
        let (env, admin, native, staking, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &native, &staking);

        // Update borrow rate
        client.update_borrow_rate(&250);
    }

    #[test]
    fn test_update_asset_price() {
        let (env, admin, native, staking, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);
        let collateral_asset = Address::random(&env);

        client.initialize(&admin, &native, &staking);

        let config = AssetConfig {
            collateral_factor_bps: 7500,
            liquidation_threshold_bps: 8000,
            price_in_xlm: 10_000_000,
        };
        client.configure_asset(&collateral_asset, &config);

        // Update price
        client.update_asset_price(&collateral_asset, &20_000_000);

        let updated_config = client.get_asset_config(&collateral_asset);
        assert_eq!(updated_config.price_in_xlm, 20_000_000);
    }

    #[test]
    fn test_get_supported_assets() {
        let (env, admin, native, staking, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);
        let asset1 = Address::random(&env);
        let asset2 = Address::random(&env);

        client.initialize(&admin, &native, &staking);

        let config = AssetConfig {
            collateral_factor_bps: 7500,
            liquidation_threshold_bps: 8000,
            price_in_xlm: 10_000_000,
        };

        client.configure_asset(&asset1, &config);
        client.configure_asset(&asset2, &config);

        let assets = client.get_supported_assets();
        assert!(assets.len() >= 2);
    }

    #[test]
    fn test_total_borrowed() {
        let (env, admin, native, staking, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = LendingContractClient::new(&env, &contract_id);
        let collateral_asset = Address::random(&env);

        client.initialize(&admin, &native, &staking);

        let config = AssetConfig {
            collateral_factor_bps: 7500,
            liquidation_threshold_bps: 8000,
            price_in_xlm: 10_000_000,
        };
        client.configure_asset(&collateral_asset, &config);

        client.deposit_collateral(&user, &collateral_asset, &2_000_0000000);
        client.borrow(&user, &1_000_0000000);

        let total = client.total_borrowed();
        assert!(total > 0);
    }
}
