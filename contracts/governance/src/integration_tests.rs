#[cfg(test)]
mod tests {
    use super::super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    fn setup_test() -> (Env, Address, Address, Address) {
        let env = Env::default();
        let admin = Address::random(&env);
        let sxlm_token = Address::random(&env);
        let proposer = Address::random(&env);

        (env, admin, sxlm_token, proposer)
    }

    #[test]
    fn test_initialize_governance() {
        let (env, admin, sxlm, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm);
        // Verify initialization
    }

    #[test]
    fn test_set_reference_supply() {
        let (env, admin, sxlm, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm);
        client.set_reference_supply(&10_000_0000000);
    }

    #[test]
    fn test_create_proposal() {
        let (env, admin, sxlm, proposer) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm);
        client.set_reference_supply(&10_000_0000000);

        let param_key = String::from_slice(&env, "voting_period");
        let new_value = String::from_slice(&env, "20160");

        let proposal_id = client.create_proposal(&proposer, &param_key, &new_value);
        assert_eq!(proposal_id, 0);
    }

    #[test]
    fn test_vote_for_proposal() {
        let (env, admin, sxlm, proposer) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);
        let voter = Address::random(&env);

        client.initialize(&admin, &sxlm);
        client.set_reference_supply(&10_000_0000000);

        let param_key = String::from_slice(&env, "voting_period");
        let new_value = String::from_slice(&env, "20160");

        let proposal_id = client.create_proposal(&proposer, &param_key, &new_value);
        client.vote(&voter, &proposal_id, &true);

        let (votes_for, votes_against) = client.get_vote_count(&proposal_id);
        assert!(votes_for > 0);
        assert_eq!(votes_against, 0);
    }

    #[test]
    fn test_vote_against_proposal() {
        let (env, admin, sxlm, proposer) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);
        let voter = Address::random(&env);

        client.initialize(&admin, &sxlm);
        client.set_reference_supply(&10_000_0000000);

        let param_key = String::from_slice(&env, "voting_period");
        let new_value = String::from_slice(&env, "20160");

        let proposal_id = client.create_proposal(&proposer, &param_key, &new_value);
        client.vote(&voter, &proposal_id, &false);

        let (votes_for, votes_against) = client.get_vote_count(&proposal_id);
        assert_eq!(votes_for, 0);
        assert!(votes_against > 0);
    }

    #[test]
    fn test_queue_proposal() {
        let (env, admin, sxlm, proposer) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm);
        client.set_reference_supply(&10_000_0000000);

        let param_key = String::from_slice(&env, "voting_period");
        let new_value = String::from_slice(&env, "20160");

        let proposal_id = client.create_proposal(&proposer, &param_key, &new_value);
        
        // Queue the proposal
        client.queue_proposal(&proposal_id);
    }

    #[test]
    fn test_get_proposal() {
        let (env, admin, sxlm, proposer) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm);
        client.set_reference_supply(&10_000_0000000);

        let param_key = String::from_slice(&env, "voting_period");
        let new_value = String::from_slice(&env, "20160");

        let proposal_id = client.create_proposal(&proposer, &param_key, &new_value);

        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.id, proposal_id);
        assert_eq!(proposal.proposer, proposer);
    }

    #[test]
    fn test_proposal_count() {
        let (env, admin, sxlm, proposer) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm);
        client.set_reference_supply(&10_000_0000000);

        let count_before = client.proposal_count();
        assert_eq!(count_before, 0);

        let param_key = String::from_slice(&env, "voting_period");
        let new_value = String::from_slice(&env, "20160");

        client.create_proposal(&proposer, &param_key, &new_value);

        let count_after = client.proposal_count();
        assert_eq!(count_after, 1);
    }

    #[test]
    fn test_set_timelock_delay() {
        let (env, admin, sxlm, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm);

        client.set_timelock_delay(&17280);

        let delay = client.get_timelock_delay();
        assert_eq!(delay, 17280);
    }

    #[test]
    fn test_set_guardian() {
        let (env, admin, sxlm, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);
        let guardian = Address::random(&env);

        client.initialize(&admin, &sxlm);

        client.set_guardian(&guardian);
    }

    #[test]
    fn test_cancel_proposal() {
        let (env, admin, sxlm, proposer) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);
        let guardian = Address::random(&env);

        client.initialize(&admin, &sxlm);
        client.set_reference_supply(&10_000_0000000);
        client.set_guardian(&guardian);

        let param_key = String::from_slice(&env, "voting_period");
        let new_value = String::from_slice(&env, "20160");

        let proposal_id = client.create_proposal(&proposer, &param_key, &new_value);
        client.cancel_proposal(&proposal_id);

        let proposal = client.get_proposal(&proposal_id);
        // Proposal should be cancelled
    }

    #[test]
    fn test_execute_proposal() {
        let (env, admin, sxlm, proposer) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm);
        client.set_reference_supply(&10_000_0000000);

        let param_key = String::from_slice(&env, "voting_period");
        let new_value = String::from_slice(&env, "20160");

        let proposal_id = client.create_proposal(&proposer, &param_key, &new_value);
        
        // Normally queue first, but testing execute flow
        client.execute_proposal(&proposal_id);
    }

    #[test]
    fn test_get_param() {
        let (env, admin, sxlm, _) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.initialize(&admin, &sxlm);

        let param_key = String::from_slice(&env, "voting_period");
        let value = client.get_param(&param_key);
        // Value should be retrieved (may be empty or default)
    }

    #[test]
    fn test_double_vote_prevention() {
        let (env, admin, sxlm, proposer) = setup_test();
        let contract_id = Address::random(&env);
        let client = GovernanceContractClient::new(&env, &contract_id);
        let voter = Address::random(&env);

        client.initialize(&admin, &sxlm);
        client.set_reference_supply(&10_000_0000000);

        let param_key = String::from_slice(&env, "voting_period");
        let new_value = String::from_slice(&env, "20160");

        let proposal_id = client.create_proposal(&proposer, &param_key, &new_value);
        client.vote(&voter, &proposal_id, &true);

        // Attempt to vote again should fail
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.vote(&voter, &proposal_id, &false);
        }));
        assert!(result.is_err());
    }
}
