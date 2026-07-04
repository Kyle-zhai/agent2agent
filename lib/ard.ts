import "server-only";
import { publicDirectoryAgents } from "./a2a";

// ---------------------------------------------------------------------------
// Agentic Resource Discovery (ARD) — cross-organization discovery layer.
//
// ARD (agenticresourcediscovery.org, Google + partners, 2026) is the open,
// federated directory that sits IN FRONT of A2A/MCP: a publisher hosts a
// static manifest at /.well-known/ai-catalog.json listing its resources as
// uniform envelopes — each carries an IANA media `type`, a domain-anchored URN
// `identifier` (urn:air:<publisher>:<namespace>:<name>), and one of `url`
// (reference) or `data` (inline). ARD is artifact-agnostic: it CATALOGS our
// existing A2A AgentCards by media-type, it does not redefine them.
//
// Privacy: we reuse the SAME deny-by-default allowlist as the A2A platform
// directory (publicDirectoryAgents → only A2A_PUBLIC_AGENT_IDS-listed managed
// agents). User agents never appear — the catalog is unauthenticated and would
// otherwise be an enumeration oracle for who runs agents here. The platform
// card itself is always listed (it is already public at /.well-known/).
// ---------------------------------------------------------------------------

const PRODUCT_NAME = "Agent2Agent";
const A2A_CARD_MEDIA_TYPE = "application/a2a-agent-card+json";

export type AiCatalogEntry = {
  /** IANA media type of the referenced resource. */
  type: string;
  /** Domain-anchored URN: urn:air:<publisher>:<namespace>:<name>. */
  identifier: string;
  /** Reference to the resource (the AgentCard URL). */
  url: string;
  name?: string;
  description?: string;
};

export type AiCatalog = {
  version: string;
  name: string;
  provider: { name: string; url: string };
  entries: AiCatalogEntry[];
};

/** The publisher segment of the URN is the catalog's own domain — domain
 *  ownership is ARD's cryptographic foundation for identity/trust. */
function publisherHost(baseUrl: string): string {
  try {
    // hostname (NOT host) — a :port would add a stray colon and break the
    // colon-delimited URN. Domain ownership is anchored on the hostname.
    return new URL(baseUrl).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

/** Build the ARD catalog for this origin: the platform AgentCard plus every
 *  operator-allowlisted public agent, each as an application/a2a-agent-card+json
 *  entry pointing at its existing AgentCard URL. */
export function buildAiCatalog(baseUrl: string): AiCatalog {
  const host = publisherHost(baseUrl);
  const entries: AiCatalogEntry[] = [
    {
      type: A2A_CARD_MEDIA_TYPE,
      identifier: `urn:air:${host}:platform:agent2agent`,
      url: `${baseUrl}/.well-known/agent-card.json`,
      name: PRODUCT_NAME,
      description:
        `${PRODUCT_NAME} platform card — a multi-agent collaboration hub hosting ` +
        `A2A-compliant agents on this origin.`,
    },
    ...publicDirectoryAgents().map((a) => ({
      type: A2A_CARD_MEDIA_TYPE,
      identifier: `urn:air:${host}:agents:${a.id}`,
      url: `${baseUrl}/api/v1/agents/${a.id}/.well-known/agent-card.json`,
      name: a.display_name,
      description: a.description,
    })),
  ];
  return {
    version: "0.9",
    name: PRODUCT_NAME,
    provider: { name: PRODUCT_NAME, url: baseUrl },
    entries,
  };
}
