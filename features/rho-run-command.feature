Feature: rho run -- dispatch coding tasks to hats or pi
  As a rho user
  I want to run coding tasks from rho
  So that rho handles persistence and memory while hats/pi handles implementation

  Background:
    Given rho is installed and on PATH
    And the current directory is a git repository

  # ---------------------------------------------------------------------------
  # NOTE: This feature is aspirational. "rho run" does not yet exist.
  # Scenarios describe the intended behavior for implementation.
  # ---------------------------------------------------------------------------

  # ---------------------------------------------------------------------------
  # Happy path: hats installed
  # ---------------------------------------------------------------------------

  Scenario: "rho run" dispatches to hats when installed
    Given hats is installed and on PATH
    And a "hats.yml" exists in the current directory
    When I run "rho run 'add jwt authentication'"
    Then rho should spawn "hats run -p 'add jwt authentication'"
    And hats stdout/stderr should stream to the terminal in real time
    And the exit code should match the hats exit code

  Scenario: "rho run" stores result summary in rho memory on completion
    Given hats is installed and completes successfully
    When I run "rho run 'add jwt authentication'"
    And the hats loop completes with exit code 0
    Then rho should add a memory entry containing:
      | field       | example                            |
      | type        | "context"                          |
      | content     | Summary of what hats accomplished  |
      | tags        | "hats,run"                         |

  Scenario: "rho run" forwards --max-iterations to hats
    Given hats is installed and on PATH
    When I run "rho run --max-iterations 5 'add jwt auth'"
    Then the spawned hats command should include "--max-iterations 5"

  # ---------------------------------------------------------------------------
  # Fallback: hats not installed
  # ---------------------------------------------------------------------------

  Scenario: "rho run" falls back to pi subagent when hats is not installed
    Given hats is NOT installed (not on PATH)
    And pi is installed and on PATH
    When I run "rho run 'add jwt authentication'"
    Then rho should spawn "pi -p 'add jwt authentication'"
    And stderr should display a message suggesting hats installation:
      """
      hats not found. Falling back to pi subagent.
      Install hats for full orchestration: cargo install hats-cli
      """
    And the exit code should match the pi exit code

  Scenario: "rho run" fails when neither hats nor pi is installed
    Given hats is NOT installed
    And pi is NOT installed
    When I run "rho run 'add jwt auth'"
    Then stderr should contain "Neither hats nor pi found"
    And the exit code should be 1

  # ---------------------------------------------------------------------------
  # Proof artifacts
  # ---------------------------------------------------------------------------

  Scenario: "--proof" generates a proof artifact
    Given hats is installed and on PATH
    When I run "rho run --proof 'add jwt authentication'"
    Then rho should pass the proof flag to hats
    And on completion, a proof file should exist in ".hats/proofs/"
    And rho should store a proof summary in memory with tag "proof"

  Scenario: "--proof" without hats installed shows error
    Given hats is NOT installed
    When I run "rho run --proof 'add jwt auth'"
    Then stderr should contain "Proof artifacts require hats"
    And the exit code should be 1

  # ---------------------------------------------------------------------------
  # Heartbeat integration
  # ---------------------------------------------------------------------------

  Scenario: Heartbeat dispatches coding tasks via "rho run"
    Given HEARTBEAT.md contains a task tagged with "[code]":
      """
      - [ ] [code] Refactor auth module to use JWT [every:weekly]
      """
    And hats is installed and on PATH
    When the rho heartbeat fires
    Then rho should dispatch the task via "rho run 'Refactor auth module to use JWT'"
    And the heartbeat should mark the task as in-progress

  Scenario: Heartbeat uses pi subagent for non-code tasks
    Given HEARTBEAT.md contains a task NOT tagged with "[code]":
      """
      - [ ] Consolidate memory [every:daily]
      """
    When the rho heartbeat fires
    Then rho should handle the task via pi subagent (not hats)

  # ---------------------------------------------------------------------------
  # Error and edge cases
  # ---------------------------------------------------------------------------

  Scenario: "rho run" without a prompt shows usage
    When I run "rho run"
    Then stderr should contain "Usage: rho run"
    And the exit code should be 1

  Scenario: "rho run" when hats.yml is missing but hats is installed
    Given hats is installed and on PATH
    And no "hats.yml" exists in the current directory
    When I run "rho run 'add jwt auth'"
    Then rho should still spawn hats (hats will use defaults or error)
    And any hats init errors should propagate to the user

  Scenario: "rho run" handles hats loop failure
    Given hats is installed but the loop fails with exit code 1
    When I run "rho run 'add jwt auth'"
    Then the exit code should be 1
    And rho should store a failure memory entry with tag "hats,run,failure"

  Scenario: "rho run" while another hats loop is running
    Given hats is installed
    And a ".hats/loop.lock" file exists (another loop is active)
    When I run "rho run 'add jwt auth'"
    Then rho should forward hats stderr to the terminal
    And the exit code should match the hats exit code
    And if hats exits non-zero due to lock contention, rho should display:
      """
      hats loop already running. Use 'hats loops' to see active loops
      or pass --worktree to run in a separate worktree.
      """
