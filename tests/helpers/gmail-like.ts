import { createHash } from "node:crypto";
import { ProviderError } from "../../src/providers/errors.js";
import type { DraftRef, MailProvider, NewDraft } from "../../src/providers/types.js";

/** A draft with every approved field of `d`, as Gmail would store it: its own ids, Message-ID and date. */
export function storedDraftOf(d: NewDraft, n: number, date: string): DraftRef {
  return {
    draftId: `dr_${n}`,
    messageId: `msg_dr_${n}`,
    threadId: d.threadId,
    messageIdHeader: `<gmail-${n}@mail.gmail.com>`,
    date,
    to: [...d.to],
    cc: [...d.cc],
    bcc: [...d.bcc],
    subject: d.subject,
    bodySha256: createHash("sha256").update(d.body, "utf8").digest("hex"),
  };
}

/**
 * A mailbox that behaves like Gmail where it matters (M4b live check): `createDraft` never de-duplicates (each call
 * is a POST and a new draft), the stored Message-ID is the provider's own, and the thread's draft list can lag
 * (`hidden`) while a read by draft id is consistent.
 */
export function gmailLike(base: MailProvider) {
  const state = {
    posts: 0,
    /** Provider reads made by a lookup: `getDraft` and `threadDrafts` calls. */
    lookups: 0,
    stored: [] as DraftRef[],
    /** The thread's draft list does not show anything yet (a landed write the list has not caught up with). */
    hidden: false,
    threadChanged: false,
    /** The next n lookup reads fail with a retryable provider error. */
    failReads: 0,
    onLookup: undefined as undefined | ((n: number) => Promise<void> | void),
    onPost: undefined as undefined | (() => Promise<void> | void),
    /** Runs after a POST's draft is stored and before the provider reports its id (the window before the record). */
    onStored: undefined as undefined | ((d: DraftRef) => Promise<void> | void),
    /**
     * The next POST fails. `lands`: the draft was created anyway. `confirmed`: the provider returned its id (the
     * engine's callback ran) before the failure, as when the read-back after a 2xx fails.
     */
    postFails: undefined as undefined | { error: unknown; lands: boolean; confirmed?: boolean },
    /** Dates of stored drafts: one minute apart from this instant. */
    epoch: Date.parse("2026-11-10T09:00:00.000Z"),
    /** Drafts ever stored: ids and dates are never reused, even after a delete. */
    made: 0,
  };
  const read = async (): Promise<void> => {
    state.lookups += 1;
    await state.onLookup?.(state.lookups);
    if (state.failReads > 0) {
      state.failReads -= 1;
      throw new ProviderError("gmail", "lookup", { phrase: "unavailable", retryable: true });
    }
  };
  const copy = (d: DraftRef): DraftRef => ({ ...d, to: [...d.to], cc: [...d.cc], bcc: [...d.bcc] });
  /** The next draft, numbered and dated after every draft stored before it. */
  const next = (d: NewDraft): DraftRef => {
    state.made += 1;
    return storedDraftOf(d, state.made, new Date(state.epoch + state.made * 60_000).toISOString());
  };

  const mail: MailProvider = {
    profile: () => base.profile(),
    searchThreads: (q, l) => base.searchThreads(q, l),
    getThread: (t, n) => base.getThread(t, n),
    threadMessageIds: async (t) => (state.threadChanged ? ["m1", "m2", "m9"] : base.threadMessageIds(t)),
    async getDraft(draftId) {
      await read();
      const d = state.stored.find((s) => s.draftId === draftId);
      return d ? copy(d) : null;
    },
    async threadDrafts(threadId) {
      await read();
      if (state.hidden) return [];
      return state.stored.filter((s) => s.threadId === threadId).map(copy);
    },
    async createDraft(d, onCreated) {
      state.posts += 1;
      await state.onPost?.();
      const failure = state.postFails;
      state.postFails = undefined;
      if (failure && !failure.lands) throw failure.error;
      const created = next(d);
      state.stored.push(created);
      await state.onStored?.(created);
      if (failure && failure.confirmed !== true) throw failure.error;
      onCreated(created.draftId);
      if (failure) throw failure.error;
      return copy(created);
    },
  };
  /** A draft the user (or an earlier process) left in the thread, identical to `d`. */
  const seed = (d: NewDraft): DraftRef => {
    const created = next(d);
    state.stored.push(created);
    return created;
  };
  return { mail, state, seed };
}
