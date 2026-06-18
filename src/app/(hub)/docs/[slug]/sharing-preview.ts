/**
 * Pure helper for the Sharing panel's live "Visible to:" preview line
 * (Audiences v2). Given the chosen audience's member-visible flag and its
 * membership display names, produce the human sentence the panel shows.
 *
 *   member_visible = 1            → "all members"
 *   members = []                  → "only you"  (admins always; no member sees it)
 *   members = [Bob]              → "you + Bob"
 *   members = [Bob, Sam]         → "you + Bob, Sam"
 *
 * "you" is the admin/author — admins always see every doc regardless. The list
 * is the set of members who additionally see it via group membership.
 */
export function visibilityPreview(input: {
  memberVisible: boolean;
  memberNames: string[];
}): string {
  if (input.memberVisible) return "all members";
  if (input.memberNames.length === 0) return "only you";
  return `you + ${input.memberNames.join(", ")}`;
}
