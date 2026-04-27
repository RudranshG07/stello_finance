#[cfg(test)]
mod tests {
    use super::super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    fn setup_test() -> (Env, Address, Address, Address) {
        let env = Env::default();
        let admin = Address::random(&env);
        let minter = Address::random(&env);
        let user = Address::random(&env);

        (env, admin, minter, user)
    }

    #[test]
    fn test_initialize_token() {
        let (env, admin, minter, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        // Verify initialization
        let token_symbol = client.symbol();
        assert_eq!(token_symbol, symbol);
    }

    #[test]
    fn test_mint_token() {
        let (env, admin, minter, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        let balance_before = client.balance(&user);
        assert_eq!(balance_before, 0);

        client.mint(&user, &1_000_0000000);

        let balance_after = client.balance(&user);
        assert_eq!(balance_after, 1_000_0000000);
    }

    #[test]
    fn test_burn_token() {
        let (env, admin, minter, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        client.mint(&user, &1_000_0000000);

        let balance_before = client.balance(&user);
        assert_eq!(balance_before, 1_000_0000000);

        client.burn(&user, &500_0000000);

        let balance_after = client.balance(&user);
        assert_eq!(balance_after, 500_0000000);
    }

    #[test]
    fn test_transfer() {
        let (env, admin, minter, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);
        let recipient = Address::random(&env);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        client.mint(&user, &1_000_0000000);

        client.transfer(&user, &recipient, &400_0000000);

        let user_balance = client.balance(&user);
        let recipient_balance = client.balance(&recipient);

        assert_eq!(user_balance, 600_0000000);
        assert_eq!(recipient_balance, 400_0000000);
    }

    #[test]
    fn test_approve() {
        let (env, admin, minter, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);
        let spender = Address::random(&env);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        let allowance_before = client.allowance(&user, &spender);
        assert_eq!(allowance_before, 0);

        client.approve(&user, &spender, &500_0000000);

        let allowance_after = client.allowance(&user, &spender);
        assert_eq!(allowance_after, 500_0000000);
    }

    #[test]
    fn test_transfer_from() {
        let (env, admin, minter, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);
        let spender = Address::random(&env);
        let recipient = Address::random(&env);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        client.mint(&user, &1_000_0000000);
        client.approve(&user, &spender, &500_0000000);

        client.transfer_from(&spender, &user, &recipient, &300_0000000);

        let user_balance = client.balance(&user);
        let recipient_balance = client.balance(&recipient);
        let allowance = client.allowance(&user, &spender);

        assert_eq!(user_balance, 700_0000000);
        assert_eq!(recipient_balance, 300_0000000);
        assert_eq!(allowance, 200_0000000);
    }

    #[test]
    fn test_total_supply() {
        let (env, admin, minter, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        let supply_before = client.total_supply();
        assert_eq!(supply_before, 0);

        client.mint(&user, &1_000_0000000);

        let supply_after = client.total_supply();
        assert_eq!(supply_after, 1_000_0000000);
    }

    #[test]
    fn test_token_metadata() {
        let (env, admin, minter, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        assert_eq!(client.name(), name);
        assert_eq!(client.symbol(), symbol);
        assert_eq!(client.decimals(), 7);
    }

    #[test]
    fn test_set_minter() {
        let (env, admin, minter, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);
        let new_minter = Address::random(&env);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        client.set_minter(&new_minter);

        let updated_minter = client.minter();
        assert_eq!(updated_minter, new_minter);
    }

    #[test]
    fn test_set_admin() {
        let (env, admin, minter, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);
        let new_admin = Address::random(&env);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        client.set_admin(&new_admin);

        let updated_admin = client.admin();
        assert_eq!(updated_admin, new_admin);
    }

    #[test]
    fn test_mint_requires_permission() {
        let (env, admin, minter, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);
        let unauthorized_user = Address::random(&env);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        // Unauthorized mint should fail
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.mint(&unauthorized_user, &1_000_0000000);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_insufficient_allowance_prevents_transfer() {
        let (env, admin, minter, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);
        let spender = Address::random(&env);
        let recipient = Address::random(&env);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        client.mint(&user, &1_000_0000000);
        client.approve(&user, &spender, &200_0000000);

        // Transfer more than allowance should fail
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.transfer_from(&spender, &user, &recipient, &300_0000000);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_multiple_transfers() {
        let (env, admin, minter, user) = setup_test();
        let contract_id = Address::random(&env);
        let client = SxlmTokenClient::new(&env, &contract_id);
        let recipient1 = Address::random(&env);
        let recipient2 = Address::random(&env);

        let name = String::from_slice(&env, "Staked XLM");
        let symbol = String::from_slice(&env, "sXLM");

        client.initialize(&admin, &minter, &7, &name, &symbol);

        client.mint(&user, &1_000_0000000);

        client.transfer(&user, &recipient1, &300_0000000);
        client.transfer(&user, &recipient2, &400_0000000);

        let user_balance = client.balance(&user);
        let recipient1_balance = client.balance(&recipient1);
        let recipient2_balance = client.balance(&recipient2);

        assert_eq!(user_balance, 300_0000000);
        assert_eq!(recipient1_balance, 300_0000000);
        assert_eq!(recipient2_balance, 400_0000000);
    }
}
