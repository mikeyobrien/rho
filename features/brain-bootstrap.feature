Feature: Brain-native personal assistant bootstrap
  As a rho user
  I want onboarding and assistant behavior to be stored in brain primitives
  So that personalization works without markdown bootstrap files

  Background:
    Given rho is installed and brain storage is available

  # ---------------------------------------------------------------------------
  # Bootstrap state + schema
  # ---------------------------------------------------------------------------

  Scenario: BS-001 detect not_started when no bootstrap meta exists
    Given brain has no bootstrap meta entries
    When bootstrap status is evaluated
    Then bootstrap status should be "not_started"

  Scenario: BS-002 mark bootstrap completed writes required meta
    Given bootstrap is not completed
    When bootstrap is marked complete for profile "personal-assistant" version "pa-v1"
    Then brain should contain meta key "bootstrap.completed" with value true
    And brain should contain meta key "bootstrap.version" with value "pa-v1"
    And brain should contain meta key "bootstrap.completedAt" with an ISO timestamp

  Scenario: BS-003 interrupted onboarding does not mark completion
    Given onboarding is in progress
    When onboarding exits before confirmation
    Then bootstrap status should not be "completed"

  # ---------------------------------------------------------------------------
  # Onboarding + mapping
  # ---------------------------------------------------------------------------

  Scenario: BS-004 successful onboarding maps answers to brain primitives
    Given onboarding answers include name timezone style and external-action policy
    When onboarding is confirmed and applied
    Then user entries should include name and timezone
    And preference entries should include communication style
    And context entries should include workflow policy

  Scenario: BS-005 existing users can opt into bootstrap retrofit
    Given an existing brain with no bootstrap completion meta
    When the user runs bootstrap run and confirms
    Then bootstrap status should become "completed"
    And existing unmanaged entries should remain unchanged

  # ---------------------------------------------------------------------------
  # Profile pack behavior
  # ---------------------------------------------------------------------------

  Scenario: BS-006 reapply of same profile version is idempotent
    Given profile "personal-assistant" version "pa-v1" has already been applied
    When bootstrap reapply is run for the same version
    Then no duplicate managed entries should be created
    And operation summary should report only NOOP actions

  Scenario: BS-007 upgrade preserves user-edited managed entries
    Given profile version "pa-v1" is applied
    And a managed entry was user-edited
    When bootstrap upgrade runs to "pa-v2"
    Then the user-edited entry should not be overwritten
    And the entry should be reported as skipped with reason "user-edited"

  Scenario: BS-008 diff classifies planned actions by merge policy
    Given current brain state and a target profile version
    When bootstrap diff is requested
    Then each managed key should be classified as ADD UPDATE NOOP SKIP_USER_EDITED SKIP_CONFLICT or DEPRECATE

  # ---------------------------------------------------------------------------
  # Command safety + observability
  # ---------------------------------------------------------------------------

  Scenario: BS-009 reset requires explicit confirmation token
    Given bootstrap is completed
    When bootstrap reset is run without confirmation token
    Then reset should fail with confirm-required error
    And no bootstrap state should be mutated

  Scenario: BS-010 audit log records lifecycle for mutating operations
    Given bootstrap operations are executed
    When a mutating bootstrap command runs
    Then audit log should contain a start event
    And audit log should contain a terminal complete-or-fail event

  Scenario: BS-011 status includes profile version and last operation result
    Given bootstrap status is requested
    When status output is rendered
    Then it should include status profile version and last-result fields

  Scenario: BS-012 slash bridge parses noisy CLI output safely
    Given bootstrap slash command output contains warning lines around JSON
    When slash bootstrap status is processed
    Then the JSON payload should still be parsed correctly
    And the status notification should include completion state and version
