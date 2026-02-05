Feature: rho login -- authenticate with LLM providers
  As a rho user
  I want to authenticate with my LLM provider via "rho login"
  So that I can use my existing subscription without manual API key configuration

  Background:
    Given pi is installed and available on PATH
    And the auth file path is ~/.pi/agent/auth.json

  # ---------------------------------------------------------------------------
  # Happy path: interactive login
  # ---------------------------------------------------------------------------

  Scenario: "rho login" starts pi for interactive authentication
    When I run "rho login"
    Then rho should exec into a pi interactive session
    And stdout should display "Starting pi session for authentication."
    And stdout should display 'Type /login to open the provider selector.'

  Scenario: Successful OAuth stores credentials in auth.json
    Given I have completed the /login OAuth flow for "anthropic" in pi
    Then ~/.pi/agent/auth.json should exist
    And it should be valid JSON
    And it should contain an "anthropic" key with at least an "access_token" field

  # ---------------------------------------------------------------------------
  # Status
  # ---------------------------------------------------------------------------

  Scenario: "--status" shows configured providers
    Given ~/.pi/agent/auth.json contains credentials for "anthropic" and "openai-codex"
    When I run "rho login --status"
    Then stdout should contain "anthropic"
    And stdout should contain "openai-codex"
    And each provider line should show the credential type (e.g., "oauth" or "api_key")
    And the exit code should be 0

  Scenario: "--status" shows token expiry information
    Given ~/.pi/agent/auth.json contains an "anthropic" credential expiring in 12 hours
    When I run "rho login --status"
    Then the "anthropic" line should contain "12h remaining"

  Scenario: "--status" shows expired tokens
    Given ~/.pi/agent/auth.json contains an "anthropic" credential that expired 2 hours ago
    When I run "rho login --status"
    Then the "anthropic" line should contain "expired"

  Scenario: "--status" shows auto-refresh capability
    Given ~/.pi/agent/auth.json contains an "anthropic" credential with a refresh token
    When I run "rho login --status"
    Then the "anthropic" line should contain "auto-refresh"

  Scenario: "--status" with no auth.json
    Given ~/.pi/agent/auth.json does not exist
    When I run "rho login --status"
    Then stdout should contain "No credentials configured"
    And stdout should suggest running "rho login"
    And the exit code should be 0

  Scenario: "--status" with empty auth.json
    Given ~/.pi/agent/auth.json contains "{}"
    When I run "rho login --status"
    Then no provider lines should be displayed
    And the exit code should be 0

  # ---------------------------------------------------------------------------
  # Logout
  # ---------------------------------------------------------------------------

  Scenario: "--logout" removes a specific provider
    Given ~/.pi/agent/auth.json contains credentials for "anthropic" and "openai-codex"
    When I run "rho login --logout anthropic"
    Then ~/.pi/agent/auth.json should no longer contain an "anthropic" key
    And ~/.pi/agent/auth.json should still contain an "openai-codex" key
    And stdout should contain "Removed credentials for anthropic"
    And the exit code should be 0

  Scenario: "--logout" for non-existent provider shows error
    Given ~/.pi/agent/auth.json contains credentials for "anthropic" only
    When I run "rho login --logout openai-codex"
    Then stderr should contain 'Provider "openai-codex" not found'
    And stderr should list configured providers (e.g., "Configured: anthropic")
    And the exit code should be 1

  Scenario: "--logout" without provider name shows usage and status
    When I run "rho login --logout"
    Then stdout should contain "Usage: rho login --logout <provider>"
    And the exit code should be 1

  # ---------------------------------------------------------------------------
  # Edge cases
  # ---------------------------------------------------------------------------

  Scenario: Login works when ~/.pi/agent/ directory does not exist
    Given the directory ~/.pi/agent/ does not exist
    When I run "rho login"
    Then pi should create the directory during OAuth flow
    And the login session should start normally

  Scenario: "rho login" fails gracefully when pi is not installed
    Given pi is NOT installed (not on PATH)
    When I run "rho login"
    Then stderr should contain "pi is not installed"
    And stdout should display the install command: "npm i -g @mariozechner/pi-coding-agent"
    And the exit code should be non-zero

  Scenario: Unknown option shows usage
    When I run "rho login --foobar"
    Then stderr should contain "Unknown option: --foobar"
    And stdout should display usage information
    And the exit code should be 1

  Scenario: "--help" shows usage
    When I run "rho login --help"
    Then stdout should contain "Usage: rho login [options]"
    And stdout should list "--status", "--logout", and "--help" options
    And stdout should list supported providers
    And the exit code should be 0

  Scenario: auth.json with corrupted JSON
    Given ~/.pi/agent/auth.json contains "not valid json {{"
    When I run "rho login --status"
    Then the command should fail with a JSON parse error
    And the exit code should be non-zero
