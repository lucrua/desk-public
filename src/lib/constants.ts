// Shared copy constants — used by the host-404 route and the /s/[token]
// not-found page so the wording can never drift between the two surfaces.

/**
 * The uniform "nothing here" heading. Rendered verbatim in both the share-
 * segment not-found page and the host-guard 404 route.
 */
export const NOTHING_HERE_HEADING = "There’s nothing at this address.";

/**
 * The follow-up sentence for the /s/[token] not-found (share link context).
 */
export const NOTHING_HERE_SHARE_BODY =
  "If someone sent you this link, it may have moved or been retired — ask them for a fresh one.";

/**
 * The follow-up sentence for the host-guard 404 (wrong hostname context).
 */
export const NOTHING_HERE_HOST_BODY =
  "This address isn’t part of the public site.";
