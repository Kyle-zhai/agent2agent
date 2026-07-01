export type DemoWorkspaceItem = {
  path: string;
  name: string;
  kind: "folder" | "html" | "git" | "md" | "json" | "agent" | "csv" | "txt" | "css";
  parent?: string;
  status?: "review";
  content?: string;
};

export type DemoWorkspaceProfile = {
  id: string;
  title: string;
  subtitle: string;
  members: Array<{ name: string; role: string; emoji: string }>;
  agents: Array<{ name: string; role: string }>;
  notes: string[];
  files: DemoWorkspaceItem[];
};

const partnerFiles: DemoWorkspaceItem[] = [
  { path: ".codebanana", name: ".codebanana", kind: "folder" },
  {
    path: ".codebanana/agents.json",
    name: "agents.json",
    kind: "json",
    parent: ".codebanana",
    content:
      '{\n  "reviewer": "Ava",\n  "runner": "Claude 3.5 Sonnet",\n  "policy": "write-ui-only"\n}\n',
  },
  { path: "user-guides", name: "user-guides", kind: "folder" },
  {
    path: "user-guides/install.md",
    name: "install.md",
    kind: "md",
    parent: "user-guides",
    content:
      "# Install guide\n\n1. Invite the teammate.\n2. Connect their assistant.\n3. Share the website-launch workspace.\n",
  },
  {
    path: ".gitignore",
    name: ".gitignore",
    kind: "git",
    content: "node_modules\n.next\ndata/*.db*\n.env*.local\n",
  },
  {
    path: "index.html",
    name: "index.html",
    kind: "html",
    content:
      "<!doctype html>\n<html>\n<head>\n  <meta charset=\"utf-8\" />\n  <style>\n    body { margin: 0; font-family: Inter, system-ui, sans-serif; color: #101729; background: #fff; }\n    main { padding: 56px 40px; text-align: center; }\n    .badge { display: inline-block; padding: 10px 18px; border-radius: 999px; background: #eef4ff; color: #1f5fc8; font-weight: 650; }\n    h1 { font-size: 44px; line-height: 1.06; margin: 28px auto 16px; max-width: 720px; }\n    p { color: #6d6f7c; font-size: 18px; line-height: 1.6; max-width: 660px; margin: 0 auto 28px; }\n    button { border: 0; border-radius: 12px; padding: 14px 22px; margin: 0 6px; font-size: 16px; font-weight: 700; }\n    .primary { background: #1f5fc8; color: white; box-shadow: 0 12px 28px rgba(31,95,200,.22); }\n    .secondary { background: white; border: 1px solid #dfe3ea; color: #202331; }\n  </style>\n</head>\n<body>\n  <main>\n    <span class=\"badge\">Partner onboarding workspace</span>\n    <h1>Launch Partner Access<br />With Human and Agent Review</h1>\n    <p>A shared room where partner teams and their agents can review files, approve terms, and ship together.</p>\n    <button class=\"primary\">Start review</button>\n    <button class=\"secondary\">View contacts</button>\n  </main>\n</body>\n</html>\n",
  },
  { path: "policy-review", name: "policy-review", kind: "folder", status: "review" },
  {
    path: "policy-review/approval.md",
    name: "approval.md",
    kind: "md",
    parent: "policy-review",
    status: "review",
    content:
      "# Review notes\n\n- Consent copy approved.\n- CTA copy uses the required free-forever clause.\n",
  },
];

const launchFiles: DemoWorkspaceItem[] = [
  { path: "handoff", name: "handoff", kind: "folder" },
  {
    path: "handoff/qa-evidence.md",
    name: "qa-evidence.md",
    kind: "md",
    parent: "handoff",
    content:
      "# QA evidence\n\n- File switching tested across Chrome.\n- Partner onboarding copy approved.\n- Bob agent attached final review notes.\n",
  },
  {
    path: "launch-plan.html",
    name: "launch-plan.html",
    kind: "html",
    content:
      "<!doctype html>\n<html>\n<head><meta charset=\"utf-8\"><style>body{font-family:system-ui;margin:0;background:#f7fafc;color:#14213d}.wrap{max-width:760px;margin:0 auto;padding:48px}.card{background:white;border:1px solid #dbe3ef;border-radius:18px;padding:28px;box-shadow:0 20px 50px #14213d18}.step{display:flex;gap:12px;margin:16px 0}.dot{width:26px;height:26px;border-radius:50%;background:#16a34a;color:white;display:grid;place-items:center;font-weight:700}</style></head>\n<body><div class=\"wrap\"><div class=\"card\"><h1>Dual-user launch checklist</h1><p>Alice owns implementation. Bob owns QA and partner approval.</p><div class=\"step\"><span class=\"dot\">1</span><span>Upload launch deck and policy notes</span></div><div class=\"step\"><span class=\"dot\">2</span><span>Run shared workspace checks</span></div><div class=\"step\"><span class=\"dot\">3</span><span>Close partner approval</span></div></div></div></body>\n</html>\n",
  },
  {
    path: "metrics.csv",
    name: "metrics.csv",
    kind: "csv",
    content: "metric,value,status\nfiles_checked,12,passed\nhandoffs,3,ready\nopen_risks,1,review\n",
  },
  {
    path: "reviewers.json",
    name: "reviewers.json",
    kind: "json",
    content:
      '{\n  "alice": { "role": "implementation", "status": "ready" },\n  "bob": { "role": "qa", "status": "reviewing" },\n  "partner": { "role": "approval", "status": "pending" }\n}\n',
  },
];

const researchFiles: DemoWorkspaceItem[] = [
  { path: "sources", name: "sources", kind: "folder" },
  {
    path: "sources/protocol-notes.md",
    name: "protocol-notes.md",
    kind: "md",
    parent: "sources",
    content:
      "# Protocol notes\n\nTwo sources confirm interoperable handoff semantics. One source flags UI-level consent wording as a launch risk.\n",
  },
  {
    path: "comparison.html",
    name: "comparison.html",
    kind: "html",
    content:
      "<!doctype html><html><head><meta charset=\"utf-8\"><style>body{font-family:system-ui;margin:32px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d8dee9;padding:10px;text-align:left}th{background:#eef4ff}</style></head><body><h1>Agent runtime comparison</h1><table><tr><th>Runtime</th><th>Strength</th><th>Risk</th></tr><tr><td>OpenClaw</td><td>Local control</td><td>Setup friction</td></tr><tr><td>Claude Code</td><td>Developer workflow</td><td>Vendor lock-in</td></tr></table></body></html>\n",
  },
  {
    path: "raw-notes.txt",
    name: "raw-notes.txt",
    kind: "txt",
    content:
      "Research scratchpad\n\n- Check A2A discovery card language.\n- Verify group consent before agent-to-agent handoff.\n- Keep file preview behavior transparent.\n",
  },
];

const designFiles: DemoWorkspaceItem[] = [
  { path: "design", name: "design", kind: "folder" },
  {
    path: "design/tokens.css",
    name: "tokens.css",
    kind: "css",
    parent: "design",
    content:
      ":root {\n  --workspace-blue: #1f5fc8;\n  --review-green: #0f9f6e;\n  --surface: #ffffff;\n  --line: #e4e7ee;\n}\n",
  },
  {
    path: "preview.html",
    name: "preview.html",
    kind: "html",
    content:
      "<!doctype html><html><head><meta charset=\"utf-8\"><style>body{margin:0;font-family:Inter,system-ui;background:#111827;color:white}.screen{min-height:100vh;display:grid;place-items:center}.panel{width:min(720px,80vw);border:1px solid #374151;border-radius:24px;padding:32px;background:#1f2937}button{background:#60a5fa;color:#0b1120;border:0;border-radius:10px;padding:12px 18px;font-weight:800}</style></head><body><section class=\"screen\"><div class=\"panel\"><h1>Reviewer console</h1><p>Design workspace for validating file previews, agent chat, and approval state.</p><button>Approve screen</button></div></section></body></html>\n",
  },
  {
    path: "design-review.md",
    name: "design-review.md",
    kind: "md",
    content:
      "# Design review\n\n- Members panel must not clip.\n- Files live in the right rail.\n- Center panel renders the selected file only.\n",
  },
];

const profiles: DemoWorkspaceProfile[] = [
  {
    id: "partner",
    title: "Partner onboarding",
    subtitle: "Partner onboarding shared workspace",
    members: [
      { name: "Iris Liu", role: "Owner", emoji: "IL" },
      { name: "Tom Zhao", role: "Partner reviewer", emoji: "TZ" },
      { name: "Ava Agent", role: "Implementation", emoji: "A" },
      { name: "Bob Agent", role: "QA", emoji: "B" },
      { name: "Mina Ops", role: "Approver", emoji: "MO" },
      { name: "Legal Bot", role: "Policy", emoji: "LB" },
    ],
    agents: [
      { name: "Alice agent", role: "workspace.write" },
      { name: "Bob agent", role: "qa.review" },
    ],
    notes: [
      "Alice agent created the partner checklist and implementation notes.",
      "Bob agent verified file navigation and launch evidence before review.",
    ],
    files: partnerFiles,
  },
  {
    id: "launch",
    title: "Dual-user launch",
    subtitle: "QA and handoff evidence workspace",
    members: [
      { name: "Alice Chen", role: "Builder", emoji: "AC" },
      { name: "Bob Park", role: "Reviewer", emoji: "BP" },
      { name: "Launch Agent", role: "Coordinator", emoji: "LA" },
      { name: "QA Agent", role: "Verifier", emoji: "QA" },
    ],
    agents: [
      { name: "Launch agent", role: "task.close" },
      { name: "QA agent", role: "evidence.write" },
    ],
    notes: [
      "Alice agent assigned Bob agent to verify the launch checklist.",
      "Bob agent attached QA evidence and marked the partner handoff ready.",
    ],
    files: launchFiles,
  },
  {
    id: "research",
    title: "Protocol research",
    subtitle: "Source review and runtime comparison",
    members: [
      { name: "Nora Analyst", role: "Research", emoji: "NA" },
      { name: "Orbit Bot", role: "Source scan", emoji: "OB" },
      { name: "Sam Reviewer", role: "Dissent check", emoji: "SR" },
    ],
    agents: [
      { name: "Orbit research bot", role: "source.find" },
      { name: "Review agent", role: "claim.check" },
    ],
    notes: [
      "Orbit summarized two confirming sources and one dissenting note.",
      "Review agent marked consent language as the remaining launch risk.",
    ],
    files: researchFiles,
  },
  {
    id: "design",
    title: "Design QA",
    subtitle: "Interface review workspace",
    members: [
      { name: "Iris Designer", role: "Design owner", emoji: "ID" },
      { name: "OpenClaw Reviewer", role: "UI audit", emoji: "OR" },
      { name: "Preview Agent", role: "Visual QA", emoji: "PA" },
    ],
    agents: [
      { name: "OpenClaw reviewer", role: "ui.audit" },
      { name: "Preview agent", role: "browser.check" },
    ],
    notes: [
      "OpenClaw reviewer checked layout consistency across workspaces.",
      "Preview agent verified that file selection updates the center panel.",
    ],
    files: designFiles,
  },
];

const knownProfileByConversation: Record<string, string> = {
  cnv_npipquar: "research",
  cnv_3xtqrdp5: "launch",
  cnv_cmzva2fk: "partner",
  cnv_9dmx7v1w: "design",
  cnv_kg3birl1: "design",
  cnv_q4ly1com: "research",
};

function stableIndex(key: string): number {
  let total = 0;
  for (const ch of key) total = (total + ch.charCodeAt(0)) % profiles.length;
  return total;
}

export function getDemoWorkspaceProfile(key: string | undefined | null) {
  if (key && knownProfileByConversation[key]) {
    return profiles.find((profile) => profile.id === knownProfileByConversation[key]) ?? profiles[0];
  }
  return profiles[key ? stableIndex(key) : 0];
}

export function getDemoWorkspaceItems(key: string | undefined | null) {
  return getDemoWorkspaceProfile(key).files;
}

export const demoWorkspaceItems = profiles[0].files;

export function getDemoWorkspaceFile(
  path: string | undefined | null,
  key?: string | null,
) {
  const files = getDemoWorkspaceItems(key);
  const fallback =
    files.find((item) => item.kind === "html") ??
    files.find((item) => item.kind !== "folder");
  if (!path) return fallback;
  return files.find((item) => item.path === path && item.kind !== "folder") ?? fallback;
}
