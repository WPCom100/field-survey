# Review resolution (T15)

PLAN §3.3, D84 (review items are delivered as ops), D90 (one item per conflicting op), D91 (this
design). Code: `src/review.ts`, `Editor.resolve`, `EditBatch.reconcileSet` / `reconcileDeleted`,
`Store.settleReview` / `restampDelete`. Tests: `src/review.test.ts`, the T15 steps in
`src/e2e/twin.e2e.test.ts`, `server/tests/test_review.py`.

## Reading

| Call | Returns |
|---|---|
| `openReviewItems(store, projectId?)` | open items, oldest first (one per conflicting op, D90) |
| `reviewFields(store, entityId)` | `{ field: [itemId…] }` for the record's open items — the `IN REVIEW` badge per field (`IN_REVIEW_BADGE`). A delete-vs-edit item marks the edited field **and** `deleted_at`; a field group marks every field in it |
| `isInReview(store, entityId, field?)` | the same as a boolean |
| `choicesFor(item)` | `['A','B']`, plus `'combine'` for one free-text field (no enum, not an `_id` column) or `'value'` for one int/real field |
| `combineText(item)` | the pre-filled Combine text "A; B" |
| `officialHead(store, entityId, field)` | the op that gives the field its official value as this iPad knows it |

Side **A** is the official head (first arrived, D37); side **B** is the op(s) that went to
review. Each candidate carries `user_id`, `client_ts`, `install_id` for the who/when/install panel.

## Resolving

```ts
const r = await editor.resolve(itemId, { choice: 'A' | 'B' } | { choice: 'combine', text? } | { choice: 'value', value }, { userName });
```

One group (`group_id` shared), `change_type = Reconcile`, `reason` auto-filled:

```
Review: chose A (Bob 2026-10-10 14:03) over B (Ann 2026-10-10 14:05)
Review: combined A (…) and B (…)
Review: set 3 over A (…) and B (…)
```

Pass `userName` (the team list); `app_user` rows are not on the iPad yet, so without it the
reason says `user …<last 6 of the id>`.

The group holds, in order:

1. **Reconcile op(s)**, one per B candidate:

   | B op | Choose A (keep official) | Choose B / Combine / value |
   |---|---|---|
   | `set f` | `set f = official value` | `restore` first if the record is officially deleted, then `set f = B` / combined text / value |
   | `delete` | `restore` (or `delete` if officially deleted) | `delete` |
   | `restore` | `delete` if officially deleted | `restore` |
   | `link_remove` | `link_add` with A's payload | `link_remove` |

   The `set` is written **even when the resolver's row already shows the value** and even on a
   deleted record: it is what brings the losing iPad (which keeps its own value while in review,
   A7) to the chosen one on its next pull. Its `base_op_id` is `officialHead(…)`: the local
   `field_head` unless that op is in `review`/`rejected`/`superseded` (the losing iPad's own
   op), in which case the latest applied op on the field.
2. **The item's fields**: `resolution`, `resolved_by_id`, `resolved_at`, `state = resolved`.

`resolution = { choice, value?, reason, reconcile_op_ids, rejected_op_ids, superseded_op_ids }`.

## Settling

Materialising `review_item.state = resolved` (or `dismissed`) moves the ops the item held out
of `review`, on the iPad (`Store.settleReview`) and on the server (`materialise._settle_review`)
alike, so every op log ends equal:

- choose A, Combine, value → the B op(s) become `rejected` (the loser);
- choose B → the B op(s) become `superseded`: their value now lives in the Reconcile op.

Side A's op stays `applied` either way: it was official until the Reconcile op, and an applied
op that turned `rejected` would change what a replay rebuilds.

## Edge cases

- **Stale resolution**: if the field moved on (a third user's edit the resolver had not pulled),
  the Reconcile op conflicts like any edit, the whole group goes to review under a new item and
  the original stays open. Nothing is overwritten.
- **Two people resolve the same item at once**: the second group conflicts on the item's own
  fields and becomes a new review item; the first resolution stands.
- **Delete vs edit, keep deleted**: the Reconcile `set` lands on a record another user deleted.
  The server does not review it again when the resolver had already pulled that delete (D91);
  an ordinary edit there is still reviewed (PLAN §3.2 step 4).
- On the resolver's iPad the item is resolved and the loser settled at once (local apply). If
  the server then reviews the group, that iPad keeps its resolution until the new item is
  resolved, which is the usual A7 state.
