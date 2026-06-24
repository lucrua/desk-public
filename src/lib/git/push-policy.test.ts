/**
 * Unit tests for the E2 ref-authz DECISION (push-policy.ts) — the pure function
 * the pre-receive hook mirrors. This is the write boundary; the matrix is
 * exhaustive + fail-closed.
 */
import { describe, it, expect } from "vitest";
import {
  refUpdateAllowed,
  isValidProposalName,
  proposalRef,
  proposalNameFromRef,
  roleIsUnrestricted,
  preReceivePolicyHookScript,
  HOSTED_BRANCH,
  PROPOSALS_PREFIX,
} from "./push-policy";
import type { SpacePushPolicy, SpaceRole } from "@/lib/spaces";

const MAIN = `refs/heads/${HOSTED_BRANCH}`;

describe("refUpdateAllowed — the ref-authz matrix", () => {
  describe("direct mode: every writer pushes anything (unchanged behaviour)", () => {
    const cases: Array<[SpaceRole, string]> = [
      ["owner", MAIN],
      ["writer", MAIN],
      ["writer", `${PROPOSALS_PREFIX}x`],
      ["writer", "refs/heads/feature"],
      ["writer", "refs/tags/v1"],
    ];
    for (const [role, ref] of cases) {
      it(`direct + ${role} + ${ref} → allowed`, () => {
        expect(refUpdateAllowed("direct", role, ref)).toBe(true);
      });
    }
  });

  describe("proposal mode: owner/admin push anything", () => {
    it("owner → main allowed", () => {
      expect(refUpdateAllowed("proposal", "owner", MAIN)).toBe(true);
    });
    it("owner → an arbitrary branch allowed", () => {
      expect(refUpdateAllowed("proposal", "owner", "refs/heads/anything")).toBe(true);
    });
    it("owner → a proposal ref allowed", () => {
      expect(refUpdateAllowed("proposal", "owner", `${PROPOSALS_PREFIX}x`)).toBe(true);
    });
  });

  describe("proposal mode: a NON-OWNER writer is restricted (the boundary)", () => {
    it("writer → main is REJECTED", () => {
      expect(refUpdateAllowed("proposal", "writer", MAIN)).toBe(false);
    });
    it("writer → proposals/<name> is ALLOWED", () => {
      expect(refUpdateAllowed("proposal", "writer", `${PROPOSALS_PREFIX}alice`)).toBe(true);
    });
    it("writer → a nested proposals/<a>/<b> is ALLOWED", () => {
      expect(refUpdateAllowed("proposal", "writer", `${PROPOSALS_PREFIX}alice/feature`)).toBe(true);
    });
    it("writer → another branch (not main, not proposals) is REJECTED (default-deny)", () => {
      expect(refUpdateAllowed("proposal", "writer", "refs/heads/sneaky")).toBe(false);
    });
    it("writer → a tag is REJECTED", () => {
      expect(refUpdateAllowed("proposal", "writer", "refs/tags/v1")).toBe(false);
    });
    it("writer → 'refs/heads/proposals' WITHOUT a name is REJECTED", () => {
      expect(refUpdateAllowed("proposal", "writer", "refs/heads/proposals")).toBe(false);
    });
    it("writer → an empty-name proposals ref is REJECTED", () => {
      expect(refUpdateAllowed("proposal", "writer", PROPOSALS_PREFIX)).toBe(false);
    });
    it("writer → a look-alike branch 'proposals-evil' is REJECTED (not under the namespace)", () => {
      expect(refUpdateAllowed("proposal", "writer", "refs/heads/proposals-evil")).toBe(false);
    });
    it("writer → a traversal-ish proposals/../main is REJECTED", () => {
      expect(refUpdateAllowed("proposal", "writer", `${PROPOSALS_PREFIX}../main`)).toBe(false);
    });
  });

  it("roleIsUnrestricted: only owner", () => {
    expect(roleIsUnrestricted("owner")).toBe(true);
    expect(roleIsUnrestricted("writer")).toBe(false);
    expect(roleIsUnrestricted("reader")).toBe(false);
  });
});

describe("isValidProposalName", () => {
  const valid = ["alice", "a", "feature-1", "a/b", "alice/feature_2", "x1/y2/z3"];
  const invalid = [
    "",
    "/leading",
    "trailing/",
    "double//slash",
    "../up",
    "a/../b",
    "UPPER",
    "with space",
    "with.dot",
    "-leadingdash",
  ];
  for (const n of valid) it(`valid: '${n}'`, () => expect(isValidProposalName(n)).toBe(true));
  for (const n of invalid) it(`invalid: '${n}'`, () => expect(isValidProposalName(n)).toBe(false));
  it("over-long name rejected", () => {
    expect(isValidProposalName("a".repeat(201))).toBe(false);
  });
});

describe("proposalRef / proposalNameFromRef round-trip", () => {
  it("proposalRef builds the namespace ref", () => {
    expect(proposalRef("alice")).toBe(`${PROPOSALS_PREFIX}alice`);
  });
  it("proposalNameFromRef extracts a valid name", () => {
    expect(proposalNameFromRef(`${PROPOSALS_PREFIX}alice/x`)).toBe("alice/x");
  });
  it("proposalNameFromRef returns null for a non-proposal ref", () => {
    expect(proposalNameFromRef(MAIN)).toBeNull();
  });
  it("proposalNameFromRef returns null for a malformed name", () => {
    expect(proposalNameFromRef(`${PROPOSALS_PREFIX}../up`)).toBeNull();
  });
});

describe("preReceivePolicyHookScript — fail-closed shape", () => {
  const script = preReceivePolicyHookScript();
  it("is a POSIX sh script", () => {
    expect(script.startsWith("#!/bin/sh")).toBe(true);
  });
  it("allows a local push when the policy env is ABSENT (env-presence=HTTP invariant)", () => {
    // An unset DESK_PUSH_POLICY ⟺ a trusted local/server-side push → allow. The
    // HTTP route always sets it, so this never widens what a client can do.
    expect(script).toContain('if [ -z "${DESK_PUSH_POLICY:-}" ]; then');
  });
  it("fails closed on the ROLE within the HTTP path (unset ⇒ restricted writer)", () => {
    expect(script).toContain('role="${DESK_PUSHER_ROLE:-writer}"');
  });
  it("allows everything in direct mode", () => {
    expect(script).toMatch(/policy.*=.*"direct".*\n.*exit 0/);
  });
  it("allows owner/admin in proposal mode", () => {
    expect(script).toContain('[ "$role" = "owner" ]');
  });
  it("reads the stdin ref-update lines", () => {
    expect(script).toContain("while read -r old new ref");
  });
  it("permits the proposals/* namespace", () => {
    expect(script).toContain("refs/heads/proposals/?*");
  });
});

// Hook ↔ decision agreement: the matrix the JS `refUpdateAllowed` enforces must
// match what the shell hook would do for the canonical refs. We can't run the
// shell here cheaply, so assert the decision is internally consistent across the
// full policy × role × ref grid (a regression guard if either side drifts).
describe("decision grid is total + consistent", () => {
  const policies: SpacePushPolicy[] = ["direct", "proposal"];
  const roles: SpaceRole[] = ["owner", "writer", "reader"];
  const refs = [MAIN, `${PROPOSALS_PREFIX}me`, "refs/heads/other", "refs/tags/v1"];
  it("every combination returns a boolean", () => {
    for (const p of policies)
      for (const r of roles)
        for (const ref of refs) expect(typeof refUpdateAllowed(p, r, ref)).toBe("boolean");
  });
  it("the ONLY rejections are proposal-mode non-owner non-proposals refs", () => {
    for (const p of policies)
      for (const r of roles)
        for (const ref of refs) {
          const allowed = refUpdateAllowed(p, r, ref);
          const isRestricted = p === "proposal" && r !== "owner";
          const isProposalRef = ref.startsWith(PROPOSALS_PREFIX) && ref.length > PROPOSALS_PREFIX.length;
          if (isRestricted && !isProposalRef) expect(allowed).toBe(false);
          else expect(allowed).toBe(true);
        }
  });
});
