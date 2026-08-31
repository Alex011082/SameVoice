import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireActor } from "../auth.js";
import { normalizePhone } from "../phoneVerification.js";
import { getUserByPhone, linkContactPair } from "../store.js";
import { apiError } from "../types.js";

/**
 * Adding a contact BY PHONE NUMBER — the one way two people who both registered
 * by phone can reach each other at all.
 *
 * Why it exists: a number that passes verification is joined to the four seeded
 * test identities and to nothing else, deliberately and NOT transitively
 * (STAGE0_AUTO_JOIN_TEST_IDENTITIES in backend/src/store.ts). So two humans on
 * real numbers never appeared in each other's contact lists and could not dial
 * each other from the contacts screen; the only bridges were a seeded test
 * account and a pasted invite link. That is fine for four fixed test profiles
 * and useless the moment two live testers want to talk.
 *
 * The number is normalized by phoneVerification.normalizePhone() — the same
 * parser that decided what the number looked like when the account was created.
 * A second parser here would mean "054-1234567" reaching a different string
 * than the one in the index, and the lookup would miss a user who is plainly
 * there. There is one parser on purpose.
 */

const byPhoneBody = z.object({ phone: z.string().min(1).max(40) }).strict();

/**
 * Ten lookups per hour per user.
 *
 * WHY AN UNLIMITED VERSION IS A PHONE-BOOK ENUMERATION TOOL. An Israeli mobile
 * number is a fixed prefix plus seven digits, so one prefix is ten million
 * candidates and the whole mobile space is a small multiple of that. It is
 * arithmetic, not a guess: a script that may call this endpoint as often as it
 * likes walks that space and keeps the hits, and what it holds at the end is a
 * list of numbers that use this product — which is to say, a list of people who
 * regularly talk to someone in a language they do not share. That is a fact
 * about a person, tied to the identifier they cannot change.
 * Worse than a read-only leak, this endpoint WRITES: every hit also inserts the
 * caller into the stranger's contact list, where the stranger sees the name and
 * can be rung by it. Unlimited, this is not a lookup; it is a cold-call machine
 * that builds its own list.
 *
 * The budget is keyed on the session's USER, not on the token, so minting a
 * fresh session (logging in again) does not hand out a fresh budget.
 *
 * What it does NOT stop, stated plainly: registering is free. With
 * AUTH_PHONE_ALLOWLIST empty — the default, and the thing buildApp() warns
 * about at boot — anyone who can reach the server can create users, and each
 * new user arrives with a fresh budget. So this limit bounds a PERSON, not an
 * attacker with a script, until that allowlist is set. It is still worth
 * having: it is what makes the slow leak below slow.
 *
 * Ten and one hour are not measured: nobody has yet watched a tester add
 * contacts, so there is no distribution to pick a percentile from. The bias is
 * deliberate — comfortably more than a person adds in one sitting, far less
 * than a script needs to be worth writing. Measure and adjust rather than
 * treating these two numbers as findings.
 */
export const ADD_BY_PHONE_LIMIT = 10;
const ADD_BY_PHONE_WINDOW_MS = 60 * 60 * 1000;

interface Budget {
  windowStartMs: number;
  used: number;
}

const budgets = new Map<string, Budget>();

/**
 * A row per user who has ever used this endpoint, and nothing removed it: a
 * lapsed budget was only ever replaced when that same user came back. Registering
 * is free while AUTH_PHONE_ALLOWLIST is empty — the paragraph above says so —
 * so "a row per user" is "a row per request an attacker cares to make". Dropping
 * the lapsed ones on the way past keeps the map the size of the last hour's
 * callers instead of the size of everyone who ever called.
 */
function sweepLapsedBudgets(nowMs: number): void {
  for (const [userId, budget] of budgets) {
    if (nowMs - budget.windowStartMs >= ADD_BY_PHONE_WINDOW_MS) budgets.delete(userId);
  }
}

/** Consumes one unit; returns the seconds to wait when there is nothing left. */
function spendBudget(userId: string, nowMs: number): { allowed: boolean; retryAfterSeconds: number } {
  sweepLapsedBudgets(nowMs);
  const budget = budgets.get(userId);
  if (!budget || nowMs - budget.windowStartMs >= ADD_BY_PHONE_WINDOW_MS) {
    budgets.set(userId, { windowStartMs: nowMs, used: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (budget.used >= ADD_BY_PHONE_LIMIT) {
    const waitMs = ADD_BY_PHONE_WINDOW_MS - (nowMs - budget.windowStartMs);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
  budget.used += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export const contactRoutes: FastifyPluginAsync = async (app) => {
  /**
   * THE ANSWER IS THE SAME WHETHER OR NOT THE NUMBER BELONGS TO ANYONE.
   *
   * A route that replies "no such user" is a membership oracle: hand it a
   * number, learn whether that person is registered. It is the leak GET
   * /api/users WAS until 31.08.2026 — every registered person's name, language
   * and gender, to anyone who could reach the port, narrowed to the four test
   * accounts by the web client and by nothing on the server. That route now
   * answers with the seeded grid and nobody else (see the comment on it).
   * Turning "add by number" into a yes/no lookup would reopen the same hole by
   * a second door, and a worse one: the query is a phone number, the identifier
   * a person cannot change and did not choose to publish here.
   *
   * So there is exactly one success answer, 200 `{ requested: true }`, for a
   * number that matched, a number that matched nobody, a number already in the
   * caller's list, and the caller's own number. No count, no name, no distinct
   * status code, and the number is NOT echoed back: a phone number goes to its
   * owner and to nobody else, and the person on the other end of this request
   * is not its owner.
   *
   * A 400 for a string that is not a phone number at all stays a 400, and that
   * is not a leak: the answer depends only on what the caller typed, never on
   * who else exists.
   *
   * WHAT THIS DOES NOT CLOSE, because pretending otherwise would be worse than
   * the hole. The pair is created immediately in both directions, so a caller
   * who reads GET /api/users/:id/contacts one request later still learns
   * whether the number is registered. The response is not an oracle; the
   * contact list is a slower one, and the rate limit above is what stands
   * between "slower" and "a phone book". Closing it properly needs the other
   * side's consent — an invite that the recipient accepts before either of them
   * appears in the other's list — which is a different feature with a screen of
   * its own. This endpoint is the smallest thing that lets two testers call
   * each other; it is not the final privacy design, and the invite flow is what
   * replaces it.
   *
   * TIMING, WHICH IS NOW MEASURED. This comment used to say the difference
   * between a hit and a miss was "не измерено, and it is not defended against
   * here". It was measured on 31.08.2026, on loopback, 40 samples a side, each
   * caller inside its own budget: a hit came back in 1.230 ms at the median and
   * never under 1.087 ms, a miss in 0.737 ms and never over 1.136 ms. The
   * distributions barely touch — ONE request told you whether a number was
   * registered, and the identical body above told you nothing. The cause is not
   * subtle: a hit wrote the whole identity snapshot to disk before replying and
   * a miss did no I/O at all.
   *
   * So the write no longer happens before the reply; see the scheduling below.
   * What is left on the measured path is two Map inserts against nothing, which
   * is microseconds and under the noise on a real network. This does not make
   * the endpoint private — the contact list one request later is still the
   * oracle named above — it makes the response say as little as it claims to.
   */
  app.post("/api/contacts/by-phone", async (req, reply) => {
    const ownerId = requireActor(req, reply);
    if (ownerId === null) return reply;

    const parsed = byPhoneBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(apiError("bad_request", "enter a phone number"));
    }
    const phone = normalizePhone(parsed.data.phone);
    if (!phone) {
      return reply
        .code(400)
        .send(
          apiError(
            "bad_request",
            "enter an Israeli mobile number or an international number with +",
          ),
        );
    }

    // Charged before the lookup, so an attempt costs the same whether or not it
    // hits. Charging only on a hit would refund exactly the misses that
    // enumeration is made of.
    const budget = spendBudget(ownerId, Date.now());
    if (!budget.allowed) {
      reply.header("retry-after", String(budget.retryAfterSeconds));
      return reply
        .code(429)
        .send(
          apiError("rate_limited", "too many add-by-number requests — wait and try again later"),
        );
    }

    const peer = getUserByPhone(phone);
    // Both directions, always. A one-way row lets the caller dial out and never
    // receive: the other side never sees him in the list and presence never
    // reports him — which is the failure the contact graph was rebuilt around
    // (linkContactPair() and joinEveryone() in backend/src/store.ts). The
    // caller's own number falls through here with nothing to link, and gets the
    // same answer as everything else.
    const linked = peer !== undefined && peer.id !== ownerId;
    if (linked) {
      // "deferred" moves the SNAPSHOT WRITE off the reply path and nothing
      // else: the two contact rows land in memory right here, so the contact
      // list is correct on the very next request, and only the half-millisecond
      // of disk that used to separate a hit from a miss on the clock happens
      // after the response is on the socket. A crash inside that tick costs one
      // re-typed number; keeping the write in front of the reply cost a
      // one-request membership oracle over every number in the country.
      linkContactPair(ownerId, peer!.id, "deferred");
    }

    // The number is not in this line, and never will be. `linked` is: it says
    // whether a pair was written without naming what was looked up, which is
    // what an operator needs to tell "the feature is broken" from "nobody with
    // that number is registered".
    req.log.info({ ownerId, linked }, "add contact by phone");

    return { requested: true };
  });
};
