import "server-only";

// Pluggable, zero-dependency mailer. No SMTP library — providers are either
// the dev console or an HTTPS JSON API reached with global fetch.
//
// MAIL_PROVIDER:
//   "console" (default) — log the email to stderr. Dev / self-host works with
//                         zero config; the reset/verify link is in the logs.
//   "resend"            — POST https://api.resend.com/emails (needs RESEND_API_KEY).
//   "webhook"           — POST MAIL_WEBHOOK_URL with {from,to,subject,html,text}
//                         (bring your own provider/relay).
// MAIL_FROM — sender address (default "Agent2Agent <no-reply@localhost>").
//
// sendEmail NEVER throws into the caller's flow on a delivery failure — it
// returns { ok, error? } and logs. Password-reset/verify callers stay
// enumeration-safe (same user-facing response whether or not mail went out).

export type EmailMessage = {
  to: string;
  subject: string;
  /** Plain-text body. HTML is derived from it when a provider needs HTML. */
  text: string;
};

export type SendResult = { ok: boolean; provider: string; error?: string };

function mailFrom(): string {
  return process.env.MAIL_FROM ?? "Agent2Agent <no-reply@localhost>";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textToHtml(text: string): string {
  // Minimal: escape + linkify bare URLs + keep line breaks. Good enough for
  // transactional reset/verify mails; we control the body.
  const escaped = escapeHtml(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1">$1</a>',
  );
  return `<div style="font-family:system-ui,sans-serif;line-height:1.6">${escaped.replace(/\n/g, "<br>")}</div>`;
}

/** Test seam: the console provider records here so tests can assert content
 *  without scraping stderr. Never used in production paths. */
export const _sentForTests: EmailMessage[] = [];

export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const provider = (process.env.MAIL_PROVIDER ?? "console").toLowerCase();
  try {
    if (provider === "resend") {
      const key = process.env.RESEND_API_KEY;
      if (!key) {
        console.error("[mailer] MAIL_PROVIDER=resend but RESEND_API_KEY unset");
        return { ok: false, provider, error: "RESEND_API_KEY unset" };
      }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: mailFrom(),
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          html: textToHtml(msg.text),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[mailer] resend HTTP ${res.status}: ${body.slice(0, 200)}`);
        return { ok: false, provider, error: `HTTP ${res.status}` };
      }
      return { ok: true, provider };
    }

    if (provider === "webhook") {
      const url = process.env.MAIL_WEBHOOK_URL;
      if (!url) {
        console.error("[mailer] MAIL_PROVIDER=webhook but MAIL_WEBHOOK_URL unset");
        return { ok: false, provider, error: "MAIL_WEBHOOK_URL unset" };
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: mailFrom(),
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          html: textToHtml(msg.text),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        console.error(`[mailer] webhook HTTP ${res.status}`);
        return { ok: false, provider, error: `HTTP ${res.status}` };
      }
      return { ok: true, provider };
    }

    // console (default)
    _sentForTests.push(msg);
    console.error(
      `[mailer:console] To: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n`,
    );
    return { ok: true, provider: "console" };
  } catch (err) {
    console.error(
      "[mailer] send failed:",
      err instanceof Error ? err.message : err,
    );
    return {
      ok: false,
      provider,
      error: err instanceof Error ? err.message : "send failed",
    };
  }
}
