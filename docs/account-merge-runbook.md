# Desk — merging a duplicate account (email move)

Runbook for folding a second account into one, by moving its email onto the keeper
account. Use this when the same person ended up with two `users` rows — e.g. Lucas
has `lucas@example.net` as a SEPARATE admin row (added during an earlier login
fix) that should become a secondary email on his `lucas@example.org` account.

This is the only "merge" Desk supports: moving an **email** between accounts. There
is no content-reattribution tool — and you don't need one (see the note below).

## The one-paragraph version

Approve-as-alias is the idempotent path: instead of approving an access request as
a new user, attach its email to an existing user. For an email that already lives
on its own `users` row, first remove it from that row, then add it to the keeper,
then deactivate the now-emailless orphan row. All four actions are admin UI / MCP
operations — no raw SQL.

## Steps (admin UI)

Assume **keeper** = `lucas@example.org`'s row, **orphan** = the
`lucas@example.net` row.

1. **/admin → Users.** Find the **orphan** row (`lucas@example.net`). It carries
   that address as its primary email chip.
2. On the orphan row, click **×** on the `lucas@example.net` chip to remove it.
   - The orphan row has no service token, so removing its *last* email is blocked
     (last-email guard). Work around it by either (a) removing it AFTER it's been
     re-added to the keeper is impossible (uniqueness), so instead **deactivate the
     orphan first is fine** — but the clean order is: temporarily the orphan keeps
     its email until step 3 moves it. To satisfy the guard, give the orphan a
     throwaway service token via the token ✎ editor, OR simply **deactivate** the
     orphan and accept it keeps a dormant email (the keeper can't claim the address
     while it's still on the orphan — so you DO need to free it). The reliable
     sequence is below in "If the guard blocks you".
3. On the **keeper** row, click **+ email**, enter `lucas@example.net`, **add**.
   Now any login via either address resolves the keeper. If the keeper row has
   `role='admin'`, that login is admin regardless of which address is used.
4. **Deactivate the orphan row** (it now has no reachable login). Leave it
   deactivated as a tombstone, or remove its remaining identifiers.

### If the last-email guard blocks freeing the orphan's address

The guard refuses to remove the **last** email of a user **without** a service
token. To move the address off the orphan:

1. On the orphan row, set a throwaway **service token** Client ID via the token ✎
   editor (any placeholder string). The orphan is now token-ful, so its last email
   is removable.
2. **×** the `lucas@example.net` chip on the orphan → the address is freed.
3. On the keeper, **+ email** → `lucas@example.net` → **add**.
4. **Deactivate** the orphan row.

## Steps (REST / API equivalent)

User & email management is a **web-UI / REST** surface — it has no MCP tool (the
Slice-1.5 interface audit kept MCP to what a headless agent drives; user admin is
not that). Use the admin UI above, or the REST API directly:

```
# 1. Free the address from the orphan (give it a token first if it's the last email)
PATCH  /api/users/<orphanId>                              { "token_name": "merge-tombstone" }
DELETE /api/users/<orphanId>/emails/lucas%40example.net

# 2. Add it to the keeper
POST   /api/users/<keeperId>/emails                       { "email": "lucas@example.net" }

# 3. Tombstone the orphan
PATCH  /api/users/<orphanId>                              { "active": false }
```

## Note on content owned by the orphan row

You do **not** need to rewrite any foreign keys. Authored content stamps a
**denormalized display name** (`doc_versions.published_by`, `comments.author_name`,
`revisions.author_name` are plain strings — the principal's display name at write
time), not a `users.id` FK. So docs/comments/revisions published by the orphan keep
their byline string and need no reattribution. The live `users.id` references are
`cards.owner_user_id`, `docs.owner_user_id`, and `space_members.user_id`; if the
orphan owned cards or docs, or was a member of a space, reassign those from the
board / a doc's **Set owner…** / the space's members panel before deactivating
(small, visible surfaces — not a bulk migration). (Audiences were retired in the
Gen-2 consolidation; the dormant `audience_members` table is no longer read.)
