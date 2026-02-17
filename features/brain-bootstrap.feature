Feature: Brain-native agentic bootstrap
  As a rho user
  I want onboarding and assistant behavior to be stored in brain primitives
  So that personalization works without markdown bootstrap files

  Background:
    Given rho is installed and brain storage is available

  Scenario: BS-001 detect not_started when no bootstrap meta exists
    Given brain has no bootstrap meta entries
    When bootstrap status is evaluated
    Then bootstrap status should be "not_started"

  Scenario: BS-002 mark bootstrap completed writes required meta
    Given bootstrap is not completed
    When bootstrap is marked complete for revision "agentic-v1"
    Then brain should contain meta key "bootstrap.completed" with value true
    And brain should contain meta key "bootstrap.version" with value "agentic-v1"
    And brain should contain meta key "bootstrap.completedAt" with an ISO timestamp

  Scenario: BS-003 run activates agentic bootstrap injection
    Given bootstrap is not completed
    When bootstrap run is executed
    Then bootstrap.mode should be "agentic"
    And bootstrap.phase should be "identity_discovery"
    And bootstrap.inject should be true

  Scenario: BS-004 reapply restarts identity discovery
    Given bootstrap mode is "agentic"
    And bootstrap.phase is "completed"
    When bootstrap reapply is executed
    Then bootstrap.phase should become "identity_discovery"
    And bootstrap.inject should be true

  Scenario: BS-005 diff reports agentic state instead of deterministic plan
    Given bootstrap mode is "agentic"
    When bootstrap diff is requested
    Then diff output should include mode phase and inject fields

  Scenario: BS-006 reset requires explicit confirmation token
    Given bootstrap is completed
    When bootstrap reset is run without confirmation token
    Then reset should fail with confirm-required error
    And no bootstrap state should be mutated

  Scenario: BS-007 audit log records lifecycle for mutating operations
    Given bootstrap operations are executed
    When a mutating bootstrap command runs
    Then audit log should contain a start event
    And audit log should contain a terminal complete-or-fail event

  Scenario: BS-008 slash bridge parses noisy CLI output safely
    Given bootstrap slash command output contains warning lines around JSON
    When slash bootstrap status is processed
    Then the JSON payload should still be parsed correctly
    And the status notification should include completion state and version
