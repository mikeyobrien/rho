# Create Agent SOP

## Overview

This SOP guides you through creating a new Agent Standard Operating Procedure (SOP). SOPs are structured markdown files with a `.sop.md` extension that provide step-by-step instructions for AI agents. They enable reusable, shareable workflows consistently executable across different AI systems.

Based on the [Strands Agent SOP](https://github.com/strands-agents/agent-sop) format. See also: [Introducing Strands Agent SOPs](https://aws.amazon.com/blogs/opensource/introducing-strands-agent-sops-natural-language-workflows-for-ai-agents/).

## Parameters

- **sop_topic** (required): The subject matter or task the SOP will cover
- **output_dir** (optional, default: "~/.rho/project/sops"): Directory where the SOP file will be saved. Options: `.pi/sops/` (project-local), `~/.pi/agent/sops/` (user global), `~/.rho/project/sops/` (bundled with rho)
- **include_examples** (optional, default: "true"): Whether to include an examples section
- **include_troubleshooting** (optional, default: "true"): Whether to include a troubleshooting section

**Constraints for parameter acquisition:**
- You MUST ask for all required parameters upfront in a single prompt
- You MUST support multiple input methods including:
  - Direct input: Text provided directly in the conversation
  - File path: Path to a local file containing the topic description
  - URL: Link to an internal resource
- You MUST confirm successful acquisition of all parameters before proceeding

## Format Specification

All SOPs MUST follow this format:

### File Naming
- Extension: `.sop.md`
- Naming: kebab-case (e.g., `code-review-assistant.sop.md`)

### Required Sections
1. **Title**: `# [SOP Name]` at the top
2. **Overview**: `## Overview` — concise description of purpose
3. **Parameters**: `## Parameters` — inputs the SOP accepts
4. **Steps**: `## Steps` — numbered execution steps

### Parameter Format
```markdown
- **parameter_name** (required|optional[, default: "value"]): Description
```
- Names MUST use lowercase snake_case
- Required parameters MUST be listed before optional ones
- Interactive SOPs MUST include a "Constraints for parameter acquisition" block

### Constraint System (RFC 2119)
SOPs MUST use these keywords to define behavioral boundaries:
- **MUST** / **REQUIRED**: Absolute requirement
- **MUST NOT** / **SHALL NOT**: Absolute prohibition — MUST include a `because [reason]`
- **SHOULD** / **RECOMMENDED**: Strong recommendation
- **MAY** / **OPTIONAL**: Truly optional

### Negative Constraints
You MUST NOT use negative constraints without providing a reason.
Format: `- You MUST NOT [action] because [reason/context]`

### Conditional Logic
- MUST check conditions before proceeding
- MUST specify behavior for both true/false outcomes

### Interactions
- SHOULD clearly indicate when user interaction is expected
- MUST ask one question at a time
- MUST specify where to save interaction records

## Steps

### 1. Gather Requirements

Understand what the SOP needs to accomplish.

**Constraints:**
- You MUST ask the user to describe what the SOP should do
- You MUST clarify the target audience (which agent/system will run this?)
- You MUST identify the key inputs (parameters) and outputs (artifacts)
- You MUST ask if there are existing workflows or scripts to reference
- You MUST NOT proceed without a clear understanding of the SOP's purpose because this leads to vague, unusable SOPs

### 2. Define Parameters

Specify the inputs the SOP will accept.

**Constraints:**
- You MUST list all parameters with their type, requirement level, and description
- You MUST use lowercase snake_case for parameter names
- You MUST list required parameters before optional ones
- You MUST provide default values for optional parameters where sensible
- You SHOULD include a "Constraints for parameter acquisition" block if the SOP is interactive

### 3. Write Steps

Detail the execution flow with explicit behavioral boundaries.

**Constraints:**
- You MUST break the process into numbered steps (`### 1. [Step Name]`)
- You MUST provide a natural language description for each step
- You MUST define behavioral boundaries using RFC 2119 keywords (MUST, SHOULD, MAY)
- You MUST NOT use negative constraints without providing a reason because agents need context to understand the severity of restrictions
- You SHOULD ensure steps build logically upon each other
- You MUST include verification/validation in steps where the agent needs to confirm work is done
- Each step SHOULD be independently testable where possible

### 4. Add Examples

Provide sample inputs and expected outputs.

**Constraints:**
- If `include_examples` is "true", you MUST add an `## Examples` section
- You SHOULD include at least one complete example showing input and output
- You SHOULD include edge case examples where appropriate
- You MUST use clear formatting for code blocks and example data

### 5. Add Troubleshooting

Document common failure modes and their resolutions.

**Constraints:**
- If `include_troubleshooting` is "true", you MUST add a `## Troubleshooting` section
- You SHOULD cover the most likely failure scenarios
- Each troubleshooting entry SHOULD include: symptom, cause, and resolution
- You SHOULD include guidance for when to stop and ask the user vs. retry autonomously

### 6. Write and Verify

Save the SOP file and validate its structure.

**Constraints:**
- You MUST save the file as `{output_dir}/{kebab-case-name}.sop.md`
- You MUST verify the file contains all required sections (Title, Overview, Parameters, Steps)
- You MUST verify all constraints use RFC 2119 keywords
- You MUST verify all negative constraints include a reason
- You MUST verify parameter names use snake_case
- You MUST read back the file after writing to confirm it was saved correctly
- You MUST present the final SOP to the user for review
- You SHOULD suggest running `/sop` to verify the new SOP appears in the list

## Examples

### Example Input
```
sop_topic: "Automated code review that runs linting, checks test coverage, and summarizes findings"
output_dir: "~/.rho/project/sops"
```

### Example Output
```
Created: ~/.rho/project/sops/code-review.sop.md

Sections:
  # Code Review
  ## Overview — Automated code review pipeline
  ## Parameters — repo_path (required), coverage_threshold (optional, default: 80)
  ## Steps — 5 steps: lint, test, coverage, summarize, report
  ## Examples — Single repo example
  ## Troubleshooting — Missing dependencies, test failures

Run /sop code-review to execute.
```

## Troubleshooting

### Invalid File Extension
If the output path does not end in `.sop.md`, append the correct extension before creating the file.

### Vague Constraints
If constraints lack RFC 2119 keywords, rewrite them to explicitly state the requirement level (e.g., change "Do not delete" to "You MUST NOT delete... because...").

### SOP Not Appearing in /sop List
Verify the file is in one of the discovery directories:
- `.pi/sops/` (project-local)
- `~/.pi/agent/sops/` (user global)
- `~/.rho/project/sops/` (bundled with rho)

The file must end in `.sop.md` to be discovered.

### Parameters Not Resolving
Cross-references between parameters (e.g., `{project_name}` in `project_dir`) are resolved automatically. Ensure the referenced parameter is defined and collected before the one that uses it.
