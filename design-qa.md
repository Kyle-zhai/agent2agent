# Design QA

final result: passed

## Scope

Compared the user-provided 1536 x 1024 Partner onboarding reference against the
local `/app` capture at `tmp/a2a-app-capture.png`.

## Checked

- White `A2A` left rail is present; black rail has been removed.
- `Files` panel matches the reference file-tree content on `/app` and is hidden
  on `/app/contacts`.
- Center pane shows `index.html`, preview toolbar, `Preview live`, NovaMind AI,
  nested `Getting started / Consent status`, and the bottom deployment metrics.
- Right-side `Team Agent` execution/chat rail is present at desktop width on
  `/app` and hidden on `/app/contacts`.
- The former top collaborator/agent strip is now inside the native `Members`
  dropdown and includes the two actions `Invite collaborator` / `Add my agent`.
- Removed/avoided previous unwanted patterns: `1 use` badge, Bob/Carol self rows
  as product language, and card-like outer app shell.

## Remaining Polish

- The collaborator avatars are cropped from the supplied reference image and
  now read as photo avatars, though exact source identity assets should replace
  them later if this moves from prototype to production.
