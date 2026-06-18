# Reviewer 收到的真实审查 prompt（针对最终 brief）

注意结尾的 **# Deterministic acceptance tests (ground truth)** 区块 —— 这是本次修复注入的锚点，把 reviewer 钉在真实 `check.sh` 结果上。

```
# Task under review
title: Write the LedgerLoom GTM brief
description:
Using the facts in gtm/research.md, write the go-to-market brief gtm/brief.md for LedgerLoom (an embedded-finance reconciliation API for vertical SaaS). Required sections, EXACT H2 headings in this order: '## Market Size', '## Competitors', '## Risks', '## Recommendation', '## Sources'. Competitors must be a markdown table with a Pricing column and at least 3 rows. The Recommendation must state GO or NO-GO with a justification. List at least 3 source URLs. At least 1200 characters. The workspace has gtm/check.sh which verifies all of this — make it print 'ALL CHECKS PASS'.
required_capabilities: workspace.write
success_criteria: [{"type":"test_command","cmd":"bash gtm/check.sh"},{"type":"diff_review","min_approvers":1,"approver_capability":"market.feasibility"}]

# Diff summary (vs parent snap_79ynwcjierk0)
- modified gtm/brief.md (4004b)

# Changed file contents (truncated)

## gtm/brief.md
```
## Market Size

The global embedded finance market is projected to reach $138 billion by 2027, according to Grand View Research's 2023 market analysis. This represents a significant opportunity for LedgerLoom, which targets the vertical SaaS segment—a rapidly growing subset of the broader embedded finance ecosystem. Vertical SaaS companies increasingly require specialized financial infrastructure to handle reconciliation across diverse payment channels, banking partners, and accounting systems. With vertical SaaS expected to grow to over $12 billion in annual revenue by 2025 (Statista, 2023), LedgerLoom's embedded reconciliation API addresses a critical pain point in this expanding market. Focusing on the property management SaaS vertical specifically—which accounts for approximately 8% of the total vertical SaaS market—creates a serviceable obtainable market (SOM) of approximately $1 billion. The timing is urgent: new SEC guidance on financial reporting accuracy (Q3 2023) and the rapid adoption of real-time payments infrastructure (up 42% YoY in 2023 per FedNow data) are forcing vertical SaaS companies to modernize reconciliation capabilities immediately. Additionally, the 2024 IRS electronic filing mandate for businesses processing over $600 in payments creates immediate pressure for accurate, automated reconciliation workflows.

## Competitors

| Competitor | Key Differentiators | Pricing | Weaknesses vs LedgerLoom |
|------------|---------------------|---------|--------------------------|
| Stripe | Broad payment platform with reconciliation as a secondary feature; requires significant customization for vertical SaaS needs | Custom pricing based on volume and features | Lacks ASC 606-native reconciliation for subscription verticals and cannot handle complex revenue recognition rules specific to vertical SaaS |
| Modern Treasury | Financial operations infrastructure focused on payments and reconciliation; strong enterprise focus but less vertical-specific | Starts at ~$1,500/month for core reconciliation features | Built for generic fintechs rather than vertical SaaS; no pre-built connectors for industry-specific accounting systems like Yardi or AppFolio |
| Unit | Banking-as-a-service platform with built-in reconciliation tools; designed for fintechs rather than vertical SaaS providers | Custom pricing based on transaction volume and integration complexity | No vertical-specific reconciliation logic for industries like healthcare billing or construction project accounting |

## Risks

- Cross-jurisdictional regulatory compliance complexity for financial reconciliation (e.g., varying GAAP/IFRS requirements, tax reporting rules)
- Integration friction with legacy accounting systems commonly used by vertical SaaS companies (e.g., QuickBooks Desktop, Sage)
- Data security and privacy risks when handling sensitive financial data across multiple systems and cloud environments

## Recommendation

GO — LedgerLoom addresses a well-defined, urgent market need with a differentiated solution that competitors cannot match in the vertical SaaS space. The $1 billion SOM in property management SaaS provides a viable beachhead, and the regulatory tailwinds (SEC guidance, IRS mandates) create immediate demand. LedgerLoom's vertical-specific reconciliation capabilities—including ASC 606 compliance, pre-built connectors for industry-specific accounting systems, and domain-specific logic for revenue recognition—create meaningful defensibility against general-purpose financial infrastructure platforms. With the embedded finance market projected to reach $138 billion by 2027 and vertical SaaS growing to $12 billion annually by 2025, the timing and market opportunity are optimal for launch.

## Sources

- https://www.grandviewresearch.com/industry-analysis/embedded-finance-market
- https://www.mordorintelligence.com/industry-reports/embedded-finance-market
- https://www.statista.com/statistics/1309425/vertical-saas-market-size-worldwide/

```

# Deterministic acceptance tests (ground truth)
These automated acceptance tests were just run against this exact snapshot and PASS:
- "bash gtm/check.sh": PASS (exit=0)
These tests are the authoritative acceptance signal — the build accepts this code as functionally complete. Do NOT claim the code is incomplete, or that output/sections are missing, if the tests pass. Only request changes for a SPECIFIC defect the tests cannot catch (e.g. a fabricated figure, an unsafe pattern), and name it exactly.

# Your task as reviewer
Decide whether to approve or request changes. Respond with a single JSON object on one line: {"decision":"approve"|"request_changes","reason":"<short why>"}
```
