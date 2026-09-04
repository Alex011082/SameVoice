import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import {
  CALL_ID_RE,
  isRingLive,
  roomNameFor,
  USER_ID_RE,
  type Call,
  type CallAgentInfo,
  type CallMode,
  type CallParticipant,
  type CallRing,
  type CallState,
  type ContactOverrides,
  type ContactOverridesPatch,
  type ModeReason,
  type RingState,
  type UserProfile,
} from "./types.js";

export interface ContactRecord {
  ownerId: string;
  contactUserId: string;
  forceTranslate: boolean;
  overrides: ContactOverrides;
}

export interface PresenceRecord {
  userId: string;
  lastSeenMs: number;
}

const users = new Map<string, UserProfile>();
/** key = `${ownerId}->${contactUserId}` */
const contacts = new Map<string, ContactRecord>();
const calls = new Map<string, Call>();
const presence = new Map<string, PresenceRecord>();
/** Real-number identities only. Seeded test identities deliberately have no phone. */
const userIdByPhone = new Map<string, string>();

function contactKey(ownerId: string, contactUserId: string): string {
  return `${ownerId}->${contactUserId}`;
}

/**
 * The Stage-0 test identities: today the 2x2 grid of translation directions
 * (ru/he x m/f). Any pair of them exercises a different direction and a
 * different Hebrew gender contract, so losing access to them means no direction
 * can be tested at all.
 *
 * Captured FROM the seed rather than hand-listed beside it. A hand-written copy
 * is a second source of truth, and the two drift the first time the grid grows:
 * add a fifth seeded profile, forget to add its id to the list, and that
 * profile is born with an empty contact list and invisible to everyone else —
 * which is precisely the bug the auto-join below exists to prevent. Deriving it
 * makes that impossible instead of merely unlikely.
 */
let stage0TestIdentityIds: readonly string[] = [];

export function stage0TestIdentityIdList(): readonly string[] {
  return stage0TestIdentityIds;
}

/**
 * STAGE 0 ONLY — a real product does not auto-befriend strangers.
 *
 * Stage 0 has no invite flow and no "add contact" screen, so a number that has
 * just passed verification knows nobody. That is not a cosmetic gap: the
 * founder verified his own number against the live server, got a profile
 * (u_4e224d03a7370d19), and GET /api/users/<id>/contacts answered `[]` — he
 * could neither place a test call nor record one, while u_alex's list was fine.
 * Joining every new user to the test grid is what makes the app usable at all
 * until invites exist.
 *
 * NOT a security boundary, and not a quota: /api/auth/* is unauthenticated and
 * hands the confirmation code back in its own response, so anyone who can reach
 * the server can mint users, and every one of them lands in all four seeded
 * lists. 60 registrations take 0.1s and leave u_alex holding 63 contacts (his
 * three seeded peers plus all 60). That is survivable only because Stage 0 runs
 * behind a shared test URL with a handful of people on it; it stops being
 * survivable the moment the URL is public. Invites — the thing that removes
 * this flag — are also what bounds it.
 *
 * AND IT IS DELIBERATELY NOT TRANSITIVE. A new user joins the test grid and
 * NOTHING else, so two people who both signed up by phone do not appear in each
 * other's lists and cannot dial each other from the contacts screen — they have
 * to meet through a seeded identity or an invite link. Joining every user to
 * every user would be one word's change here and is the wrong word: it turns a
 * public test URL into a directory of everyone's name and number-derived
 * profile. The real fix is invites, not a wider blast radius.
 *
 * REMOVE WITH: this constant, its one use in createUserFromPhone(), and the
 * backend tests named "Stage-0 auto-join", the moment an invite / add-contact
 * flow lands. stage0TestIdentityIds and joinEveryone() stay — the seed still
 * needs them.
 */
export const STAGE0_AUTO_JOIN_TEST_IDENTITIES = true;

/**
 * One contact row. Idempotent on purpose: re-registering the same phone, or
 * re-running the seed, must not duplicate a contact nor silently reset the
 * per-contact overrides a tester has already set on it.
 */
function addContact(ownerId: string, contactUserId: string): void {
  // A user is never his own contact: his row would show up in his own list and
  // he could "call" himself.
  if (ownerId === contactUserId) return;
  const key = contactKey(ownerId, contactUserId);
  if (contacts.has(key)) return;
  contacts.set(key, { ownerId, contactUserId, forceTranslate: false, overrides: {} });
}

/**
 * Everyone in `userIds` becomes everyone else's contact, in BOTH directions.
 * Both directions is the whole point: a one-way list lets a user dial out and
 * never receive, because the callee never sees him and presence never lists him.
 *
 * The seed and the phone-registration path share this one function so the graph
 * cannot drift apart into two hand-written versions of the same wiring.
 */
function joinEveryone(userIds: readonly string[]): void {
  for (const a of userIds) {
    for (const b of userIds) addContact(a, b);
  }
}

function seed(): void {
  users.clear();
  contacts.clear();
  calls.clear();
  presence.clear();
  userIdByPhone.clear();

  const alex: UserProfile = {
    id: "u_alex",
    handle: "alex",
    displayName: "Alex",
    lang: "ru",
    gender: "m",
    tone: "neutral",
  };
  const noa: UserProfile = {
    id: "u_noa",
    handle: "noa",
    displayName: "Noa",
    lang: "he",
    gender: "f",
    tone: "friendly",
  };
  // Omri is the second Hebrew tester and specifically a MALE one. Hebrew
  // inflects on the speaker's gender as well as the addressee's, so testing a
  // male Hebrew speaker by patching Noa's gender at runtime was wrong twice
  // over: that patch lives in memory and silently reverts on the next backend
  // restart, and the female cloned voice kept speaking his words. Gender is a
  // property of a person, so he gets his own profile.
  const omri: UserProfile = {
    id: "u_omri",
    handle: "omri",
    displayName: "Omri",
    lang: "he",
    gender: "m",
    tone: "friendly",
  };
  // Maya completes the grid. The web client no longer hands out one link per
  // person: a tester opens the bare URL and picks gender, then language, and
  // that pair resolves to a seeded profile. Both axes have two values, so all
  // FOUR combinations must exist or a tester picks a valid pair and lands
  // nowhere. She is the (ru, f) corner.
  const maya: UserProfile = {
    id: "u_maya",
    handle: "maya",
    displayName: "Maya",
    lang: "ru",
    gender: "f",
    tone: "friendly",
  };

  users.set(alex.id, alex);
  users.set(noa.id, noa);
  users.set(omri.id, omri);
  users.set(maya.id, maya);

  // Everyone is everyone's contact. With the role picker there is no way to
  // predict which two corners of the grid a session will use, so a hand-picked
  // pair list would leave testers unable to reach each other.
  //
  // Read off the map that was just filled, so a profile added above is wired in
  // by the act of seeding it and cannot be half-added.
  stage0TestIdentityIds = [...users.keys()];
  joinEveryone(stage0TestIdentityIds);
}

seed();

/** Test-only: restore the Stage-0 seed, drop every call и снести снимок. */
export function resetStore(): void {
  seed();
  removeIdentityFile();
}

/* ============ ХРАНЕНИЕ ЛИЧНОСТЕЙ НА ДИСКЕ ============
 * Без этого блока перезапуск бэкенда стирал ВСЕХ зарегистрированных: люди
 * в памяти, память умирает вместе с процессом. Снимок лежит рядом с
 * пользователями, читается на старте поверх посева и переписывается на
 * каждое изменение — атомарно, через временный файл и rename.
 */

/** Тип журнала: подходит и pino, и любой объект с этими двумя методами. */
type IdentityLog = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
};

type Snapshot = z.infer<typeof snapshotSchema>;
type Stamp = { size: number; mtimeMs: number };
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE = "identities.json";
const langSchema = z.enum(["ru", "he"]);
const genderSchema = z.enum(["m", "f", "u"]);
const toneSchema = z.enum(["neutral", "friendly", "formal"]);
const userIdSchema = z.string().regex(USER_ID_RE);
const snapshotSchema = z
    .object({
    version: z.literal(SNAPSHOT_VERSION),
    savedAt: z.string(),
    users: z.array(z
        .object({
        id: userIdSchema,
        handle: z.string().min(1),
        displayName: z.string().min(1),
        lang: langSchema,
        gender: genderSchema,
        tone: toneSchema,
    })
        .strict()),
    // Mirrors normalizePhone()'s output shape. Validated on the way in because a
    // phone that is not E.164 here would key an index nothing can ever look up.
    phones: z.array(z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/), userId: userIdSchema }).strict()),
    contacts: z.array(z
        .object({
        ownerId: userIdSchema,
        contactUserId: userIdSchema,
        forceTranslate: z.boolean(),
        overrides: z
            .object({
            lang: langSchema.optional(),
            gender: genderSchema.optional(),
            tone: toneSchema.optional(),
        })
            .strict(),
    })
        .strict()),
})
    .strict();
/** null until loadIdentityStore() runs: importing this module writes no files. */
let identityDir: string | null = null;
let identityLog: IdentityLog | undefined;
/** The snapshot path, or null while nothing is attached. */
export function identityStorePath(): string | null {
    return identityDir === null ? null : join(identityDir, SNAPSHOT_FILE);
}
/**
 * Refuses to answer with a half-read file. A JSON parse error or a shape that
 * does not match means the process must not start: silently starting from an
 * empty store is what let the missing-contacts failure look like a client bug
 * for days, and it would do it again here — every phone user gone, the seeded
 * four present, the API answering 200 the whole time.
 *
 * `null` means only "there is no file yet", which is the ordinary first boot.
 */
function readSnapshot(file: string): Snapshot | null {
    let raw: string;
    try {
        raw = readFileSync(file, "utf8");
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT")
            return null;
        throw new Error(`SpeakEasy backend cannot start: identity store ${file} could not be read (${String(err)}).`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error([
            `SpeakEasy backend cannot start: identity store ${file} is not valid JSON (${String(err)}).`,
            "It holds every phone-registered profile and their contacts. Starting without it would",
            "silently answer \"user not found\" for all of them, so the process stops instead.",
            "Move the file aside to start from the Stage-0 seed alone — that discards those profiles.",
        ].join("\n"));
    }
    const result = snapshotSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("\n");
        throw new Error([
            `SpeakEasy backend cannot start: identity store ${file} does not match snapshot v${SNAPSHOT_VERSION}.`,
            issues,
        ].join("\n"));
    }
    return result.data;
}
/**
 * The file on top of the seed. Both halves are keyed — users by id, contacts by
 * `${ownerId}->${contactUserId}` — so a snapshot that contains the seeded four
 * (it always does, they are ordinary users once they are in it) overwrites them
 * with themselves instead of adding a second Alex.
 *
 * Rows whose endpoints are not users are dropped rather than kept: a contact
 * row pointing at a profile that no longer exists is already invisible to the
 * API (routes/users.ts filters it out of every list), so keeping it would only
 * let it live forever in the file.
 *
 * The consequence worth knowing before it surprises somebody: for an id the
 * snapshot contains, the FILE wins. Editing a seeded profile in seedIdentities()
 * therefore does not reach a server whose snapshot already holds that id — the
 * one there was written by the last PATCH /api/users/:userId. Delete the file
 * (its path is in the boot log) to come back up on the code seed alone; that
 * also discards every phone-registered profile in it.
 */
function applySnapshot(snapshot: Snapshot): void {
    for (const user of snapshot.users)
        users.set(user.id, user);
    let droppedPhones = 0;
    for (const entry of snapshot.phones) {
        if (!users.has(entry.userId)) {
            droppedPhones += 1;
            continue;
        }
        userIdByPhone.set(entry.phone, entry.userId);
    }
    let droppedContacts = 0;
    for (const contact of snapshot.contacts) {
        if (contact.ownerId === contact.contactUserId ||
            !users.has(contact.ownerId) ||
            !users.has(contact.contactUserId)) {
            droppedContacts += 1;
            continue;
        }
        contacts.set(contactKey(contact.ownerId, contact.contactUserId), contact);
    }
    if (droppedPhones > 0 || droppedContacts > 0) {
        identityLog?.warn({ droppedPhones, droppedContacts }, "identity store: dropped rows pointing at users the snapshot does not contain");
    }
}
/**
 * Point the store at `dir` and rebuild the identity half from the seed plus
 * whatever is in it. This IS the boot path — buildApp() calls it once — which is
 * also why a test can call it again to reproduce a restart without a second
 * process.
 *
 * The seed runs first, unconditionally, so the four test identities exist even
 * on a first boot with no file; see applySnapshot() for why running the file on
 * top of them cannot duplicate them.
 *
 * Throws on an unreadable or malformed file. Deliberately fatal — see readSnapshot().
 */
export function loadIdentityStore(dir: string, log?: IdentityLog): void {
    const file = join(dir, SNAPSHOT_FILE);
    // Read FIRST, then commit. A throw here must change nothing: memory keeps
    // whatever it held, and the store stays pointed where it was pointed, so the
    // next write cannot overwrite the corrupt file an operator has to go and read.
    const snapshot = readSnapshot(file);
    identityDir = dir;
    identityLog = log;
    seed();
    // The file we just read counts as "ours": the first save after boot must not
    // mistake the snapshot it was built from for another process's write and
    // announce a merge that added nothing.
    lastWritten = stampOf(file);
    if (snapshot === null) {
        log?.info({ file }, "identity store: no snapshot yet, starting from the Stage-0 seed");
        return;
    }
    applySnapshot(snapshot);
    // Досвязываем тех, кто зарегистрировался, пока действовало старое правило.
    // ИМЕННО С СЕТКОЙ, а не всех со всеми: joinEveryone([...users.keys()])
    // делал контактами посторонних друг другу людей — чужой человек появлялся
    // в списке и мог позвонить. Двое живых знакомятся через
    // POST /api/contacts/by-phone (linkContactPair), это их согласие.
    if (STAGE0_AUTO_JOIN_TEST_IDENTITIES) {
        const before = contacts.size;
        for (const id of users.keys()) {
            if (stage0TestIdentityIds.includes(id)) continue;
            joinEveryone([id, ...stage0TestIdentityIds]);
        }
        if (contacts.size !== before) {
            log?.info({ added: contacts.size - before }, "identity store: досвязаны недостающие контакты");
            saveIdentities();
        }
    }
    // Counts only: the size of the phone index tells an operator everything the
    // log needs to say and names nobody.
    log?.info({
        file,
        users: users.size,
        contacts: contacts.size,
        phoneIdentities: userIdByPhone.size,
        savedAt: snapshot.savedAt,
    }, "identity store loaded");
}
/**
 * Size and mtime of the snapshot as THIS process last left it — the one cheap
 * way to tell "the file on disk is still mine" from "somebody else has written
 * it since" without re-reading it on every save.
 */
let lastWritten: Stamp | null = null;
function stampOf(file: string): Stamp | null {
    try {
        const s = statSync(file);
        return { size: s.size, mtimeMs: s.mtimeMs };
    }
    catch {
        return null;
    }
}
/**
 * Merge a snapshot written by ANOTHER process into memory, adding only what is
 * missing here.
 *
 * Add-only, and that is the whole design: this runs immediately before we
 * overwrite the file, so everything it copies in is about to be written back.
 * A full applySnapshot() would also copy the other process's version of rows
 * this one has just edited, and the edit the route is in the middle of saving
 * would be reverted by its own save.
 *
 * Users first: the phone index and the contact graph are both filtered against
 * `users`, exactly as applySnapshot() filters them.
 */
function mergeMissing(snapshot: Snapshot): { users: number; phones: number; contacts: number } {
    let addedUsers = 0;
    let addedPhones = 0;
    let addedContacts = 0;
    for (const user of snapshot.users) {
        if (users.has(user.id))
            continue;
        users.set(user.id, user);
        addedUsers += 1;
    }
    for (const entry of snapshot.phones) {
        if (userIdByPhone.has(entry.phone) || !users.has(entry.userId))
            continue;
        userIdByPhone.set(entry.phone, entry.userId);
        addedPhones += 1;
    }
    for (const contact of snapshot.contacts) {
        const key = contactKey(contact.ownerId, contact.contactUserId);
        if (contact.ownerId === contact.contactUserId || contacts.has(key))
            continue;
        if (!users.has(contact.ownerId) || !users.has(contact.contactUserId))
            continue;
        contacts.set(key, contact);
        addedContacts += 1;
    }
    return { users: addedUsers, phones: addedPhones, contacts: addedContacts };
}
/**
 * A SECOND PROCESS ON ONE IDENTITY_DIR, which is what this guard is for.
 *
 * saveIdentities() serializes this process's entire memory, so with no check
 * the file is simply replaced by whoever wrote last: every identity the other
 * process holds and this one does not is deleted by a write that reports
 * success and logs nothing. Measured on 31.08.2026 with two backends sharing
 * one IDENTITY_DIR — a 545,725-byte snapshot holding 404 profiles was replaced
 * by a 15,834-byte one holding 14, and neither log said a word.
 *
 * Two backends is not hypothetical here: docker/entrypoint.sh points
 * IDENTITY_DIR at a persistent volume, and a restart that overlaps its
 * predecessor, or a second container on the same volume, is exactly this.
 *
 * So: before overwriting, notice that the file is not the one we left, read it,
 * and take in whatever we are missing. The write that follows is a union
 * instead of a replacement. This does NOT make two writers correct — the last
 * writer still decides a row both of them edited, and the window between this
 * stat and the rename below is real. It makes the failure lose nothing and say
 * so out loud, instead of losing everything and saying nothing.
 */
function adoptForeignWrites(file: string): void {
    const onDisk = stampOf(file);
    if (onDisk === null)
        return;
    if (lastWritten !== null &&
        onDisk.size === lastWritten.size &&
        onDisk.mtimeMs === lastWritten.mtimeMs) {
        return;
    }
    let snapshot: Snapshot | null;
    try {
        snapshot = readSnapshot(file);
    }
    catch (err) {
        // Refusing to BOOT on an unreadable file is right; refusing to SAVE on one
        // would throw out of a route handler. Overwriting it is the better of the
        // two options left — memory is the good copy either way.
        (identityLog?.error ?? identityLog?.warn)?.call(identityLog, { file, err }, "identity store: a foreign write left a file this build cannot read — overwriting it from memory");
        return;
    }
    if (snapshot === null)
        return;
    const added = mergeMissing(snapshot);
    if (added.users === 0 && added.phones === 0 && added.contacts === 0)
        return;
    identityLog?.warn({ file, ...added }, "identity store: another process is writing this directory — merged its rows in rather than overwriting them");
}
/**
 * Every mutation below ends here, synchronously, before the route replies. Sync
 * because the store's whole API is sync and every caller is a route handler
 * calling it inline: making it async would turn four functions into promises
 * across three route files for a write that happens on registration and on a
 * profile or contact edit — never on the call path, never on presence polling.
 * The cost is an event-loop stall per registration, on a snapshot that today
 * holds four seeded profiles plus the testers; its duration is не измерено.
 * If the file ever grows to where that matters, measure first, then batch.
 *
 * Written to a temporary file and renamed. rename(2) within a directory is
 * atomic, so a crash mid-write leaves either the whole previous snapshot or the
 * whole new one — never the truncated half that readSnapshot() would refuse to
 * boot on. Not fsync'd: a kernel-level crash can still lose the last write, and
 * the rename only rules out a file that exists but cannot be parsed.
 *
 * The temporary name carries the pid and four random bytes, and that is not
 * decoration: a fixed `.tmp` shared by two processes is one of them writing
 * into the file the other is about to rename into place — precisely the torn
 * file the rename was chosen to rule out.
 *
 * MODE 0600, and the directory 0700. This file holds the phone numbers — the
 * index that stops one number minting a second profile IS the numbers — and
 * the 0644 default published them to every account on the box, which is a
 * strange thing to allow in the one file that works hardest to keep them out
 * of every log line.
 */
function saveIdentities(): void {
    if (identityDir === null)
        return;
    const file = join(identityDir, SNAPSHOT_FILE);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        mkdirSync(identityDir, { recursive: true, mode: 0o700 });
        adoptForeignWrites(file);
        const snapshot = {
            version: SNAPSHOT_VERSION,
            savedAt: new Date().toISOString(),
            users: [...users.values()],
            phones: [...userIdByPhone.entries()].map(([phone, userId]) => ({ phone, userId })),
            contacts: [...contacts.values()],
        };
        writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        renameSync(tmp, file);
        lastWritten = stampOf(file);
    }
    catch (err) {
        // Loud, and the process keeps serving: the profile is usable right now, it
        // just will not survive a restart. Same call archive.ts makes when it cannot
        // write a call — an operator who sees this knows the next restart loses data.
        // The half-written temporary goes with it; on a full disk it is the thing
        // standing between the operator and the space to write the next one.
        rmSync(tmp, { force: true });
        identityLog?.warn({ file, err }, "identity store could not be written — identities created now will not survive a restart");
    }
}
/**
 * Test-only, via resetStore(). Every temporary goes, not one fixed name: a
 * write that died mid-flight leaves one named after the pid that died.
 */
function removeIdentityFile(): void {
    if (identityDir === null)
        return;
    const file = join(identityDir, SNAPSHOT_FILE);
    rmSync(file, { force: true });
    lastWritten = null;
    try {
        for (const name of readdirSync(identityDir)) {
            if (name.startsWith(`${SNAPSHOT_FILE}.`) && name.endsWith(".tmp")) {
                rmSync(join(identityDir, name), { force: true });
            }
        }
    }
    catch {
        // The directory need not exist; there is nothing to clean up if it does not.
    }
}

export function listUsers(): UserProfile[] {
  return [...users.values()];
}

export function getUser(userId: string): UserProfile | undefined {
  return users.get(userId);
}

export function getUserByPhone(phone: string): UserProfile | undefined {
  const userId = userIdByPhone.get(phone);
  return userId ? users.get(userId) : undefined;
}

export function createUserFromPhone(input: {
  phone: string;
  displayName: string;
  lang: UserProfile["lang"];
  gender: UserProfile["gender"];
}): UserProfile {
  const existing = getUserByPhone(input.phone);
  if (existing) return existing;
  let id: string;
  do {
    id = `u_${randomBytes(8).toString("hex")}`;
  } while (users.has(id));
  const user: UserProfile = {
    id,
    handle: `user_${id.slice(2, 10)}`,
    displayName: input.displayName.trim(),
    lang: input.lang,
    gender: input.gender,
    tone: "friendly",
  };
  users.set(id, user);
  userIdByPhone.set(input.phone, id);
  // See STAGE0_AUTO_JOIN_TEST_IDENTITIES: without this the new user lands in an
  // empty app. He joins the grid rather than only pointing at it, so the test
  // identities can call him back.
  if (STAGE0_AUTO_JOIN_TEST_IDENTITIES) joinEveryone([id, ...stage0TestIdentityIds]);
  saveIdentities();
  return user;
}

export function updateUser(
  userId: string,
  patch: Partial<Pick<UserProfile, "displayName" | "lang" | "gender" | "tone">>,
): UserProfile | undefined {
  const existing = users.get(userId);
  if (!existing) return undefined;
  const next: UserProfile = { ...existing, ...patch };
  users.set(userId, next);
  saveIdentities();
  return next;
}

/* Тестовые обитатели — четыре посеянных профиля и два диктора сквозного
 * прогона. Они нужны нам, но реальному человеку в списке контактов они —
 * мусор, в котором тонет живой собеседник (скрин основателя 02.09.2026: один
 * настоящий Igor на семь тестовых). Тестовые видят всех; настоящие — только
 * настоящих; основатель видит ещё и ИИ-собеседников, ему ими тестировать. */
const DRILL_SPEAKER_IDS = new Set([
  "u_141560d817f7c1af", // Тест РУ — браузерный диктор сквозного прогона
  "u_6df46c7f61d47836", // Тест ИВ — серверный диктор сквозного прогона
]);
export function isTestResident(userId: string): boolean {
  // stage0TestIdentityIds заполняется при загрузке стора — проверять надо
  // в момент вопроса, а не в момент импорта модуля (там список ещё пуст).
  return DRILL_SPEAKER_IDS.has(userId) || stage0TestIdentityIds.includes(userId);
}

/**
 * Two people become each other's contact. Used by "add a contact by phone
 * number" (backend/src/routes/contacts.ts), which is how two humans on real
 * numbers reach each other at all — the Stage-0 auto-join wires a new user to
 * the seeded four and deliberately stops there.
 *
 * It delegates to joinEveryone() rather than calling addContact() twice, and
 * that is the whole reason this function exists instead of being written out at
 * the call site: BOTH directions is the property worth having in one place. A
 * one-way row lets the adder dial out and never receive, because the other side
 * never sees him in the list and presence never reports him.
 *
 * `persist` decides WHEN the snapshot is written, never WHETHER — a contact row
 * that does not survive a restart puts the pair back to not being able to find
 * each other, which is the bug this function was added to fix.
 */
export function linkContactPair(
  userIdA: string,
  userIdB: string,
  persist: "now" | "deferred" = "now",
): void {
  joinEveryone([userIdA, userIdB]);
  // Same reason createUserFromPhone() saves after its auto-join.
  if (persist === "now") saveIdentities();
  else setImmediate(saveIdentities);
}

/**
 * Строки контактов как они есть. Прятать тестовых обитателей от живого
 * человека — работа ЭКРАНА (web/src/contact-directory.ts), а не хранилища:
 * фильтр здесь делал ответ API неправдой о том, что лежит в базе, и ломал
 * ровно то, ради чего посев существует — новичку было бы некуда звонить.
 */
export function listContacts(ownerId: string): ContactRecord[] {
  return [...contacts.values()].filter((c) => c.ownerId === ownerId);
}

export function getContact(ownerId: string, contactUserId: string): ContactRecord | undefined {
  return contacts.get(contactKey(ownerId, contactUserId));
}

export function updateContact(
  ownerId: string,
  contactUserId: string,
  patch: { forceTranslate?: boolean; overrides?: ContactOverridesPatch },
): ContactRecord | undefined {
  const existing = contacts.get(contactKey(ownerId, contactUserId));
  if (!existing) return undefined;
  const overrides: Record<string, unknown> = { ...existing.overrides };
  for (const [key, value] of Object.entries(patch.overrides ?? {})) {
    if (value === null) delete overrides[key];
    else if (value !== undefined) overrides[key] = value;
  }
  const next: ContactRecord = {
    ...existing,
    forceTranslate: patch.forceTranslate ?? existing.forceTranslate,
    overrides: overrides as ContactOverrides,
  };
  contacts.set(contactKey(ownerId, contactUserId), next);
  saveIdentities();
  return next;
}

function newCallId(): string {
  for (;;) {
    const id = `c_${randomBytes(6).toString("hex")}`;
    if (CALL_ID_RE.test(id) && !calls.has(id)) return id;
  }
}

export function createCall(input: {
  mode: CallMode;
  reason: ModeReason;
  participants: CallParticipant[];
  ring?: CallRing | null;
}): Call {
  const id = newCallId();
  const createdAt = new Date().toISOString();
  const call: Call = {
    id,
    roomName: roomNameFor(id),
    mode: input.mode,
    reason: input.reason,
    state: "created",
    createdAt,
    lastActivityAt: createdAt,
    endedAt: null,
    participants: input.participants,
    agent: { required: input.mode !== "DIRECT", dispatched: false, identity: null, error: null },
    ring: input.ring ?? null,
  };
  calls.set(id, call);
  return call;
}

export function getCall(callId: string): Call | undefined {
  return calls.get(callId);
}

/**
 * "Somebody is still interested in this call." Every mutation below records it,
 * and so does a join — which is the only signal the backend ever gets that a
 * human is actually in the room. The idle reaper measures against it.
 */
export function touchCall(callId: string): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.lastActivityAt = new Date().toISOString();
  return call;
}

export function setCallState(callId: string, state: CallState): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.state = state;
  call.lastActivityAt = new Date().toISOString();
  if (state === "ended" && call.endedAt === null) {
    call.endedAt = call.lastActivityAt;
  }
  return call;
}

export function setCallMode(callId: string, mode: CallMode, reason: ModeReason): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.mode = mode;
  call.reason = reason;
  call.agent.required = mode !== "DIRECT";
  call.lastActivityAt = new Date().toISOString();
  return call;
}

export function setCallParticipants(callId: string, participants: CallParticipant[]): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.participants = participants;
  call.lastActivityAt = new Date().toISOString();
  return call;
}

export function setCallAgent(callId: string, agent: CallAgentInfo): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.agent = agent;
  return call;
}

export function callParticipant(call: Call, userId: string): CallParticipant | undefined {
  return call.participants.find((p) => p.userId === userId);
}

export function callPeer(call: Call, userId: string): CallParticipant | undefined {
  return call.participants.find((p) => p.userId !== userId);
}

export function callCaller(call: Call): CallParticipant {
  return call.participants.find((p) => p.role === "caller")!;
}

export function callCallee(call: Call): CallParticipant {
  return call.participants.find((p) => p.role === "callee")!;
}

// ---------------------------------------------------------------------------
// Ringing
// ---------------------------------------------------------------------------

/** Newest first. The ring flow always wants the most recent match, never the oldest. */
function callsNewestFirst(): Call[] {
  return [...calls.values()].reverse();
}

export function setCallRing(callId: string, ring: CallRing | null): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.ring = ring;
  call.lastActivityAt = new Date().toISOString();
  return call;
}

export function setRingState(callId: string, state: RingState, atIso: string): Call | undefined {
  const call = calls.get(callId);
  if (!call || call.ring === null) return undefined;
  call.ring = { ...call.ring, state, respondedAt: atIso };
  call.lastActivityAt = new Date().toISOString();
  return call;
}

/**
 * Rings whose deadline has passed while the call has still not gone `active`.
 * Pure query: the caller performs the transition, because expiring a ring also
 * has to stop a dispatched agent and that is I/O the store must not own.
 */
export function dueRingCalls(nowMs: number): Call[] {
  return [...calls.values()].filter((c) => {
    if (c.ring === null || c.state === "ended") return false;
    if (Date.parse(c.ring.expiresAt) > nowMs) return false;
    // Unanswered: expires even though the caller has already joined the room and
    // flipped the call to `active` while listening to his own ringback.
    if (c.ring.state === "ringing") return true;
    // Answered but nobody actually joined: only meaningful while still `created`.
    // Once anyone joins, the call is live and the ring deadline stops applying.
    return c.ring.state === "accepted" && c.state === "created";
  });
}

/** A ring this user must answer: they are the callee and it is still ringing. */
export function findIncomingRing(userId: string, nowMs: number): Call | undefined {
  return callsNewestFirst().find(
    (c) =>
      c.ring !== null &&
      c.ring.state === "ringing" &&
      c.state !== "ended" &&
      Date.parse(c.ring.expiresAt) > nowMs &&
      callCallee(c).userId === userId,
  );
}

/**
 * A ring this user started. Live ones always; terminal ones only inside a grace
 * window, so the caller's UI can say "declined" / "no answer" instead of the
 * ring silently disappearing.
 */
export function findOutgoingRing(userId: string, nowMs: number, graceMs: number): Call | undefined {
  return callsNewestFirst().find((c) => {
    if (c.ring === null || callCaller(c).userId !== userId) return false;
    if (isRingLive(c.ring.state)) return c.state !== "ended";
    const at = c.ring.respondedAt === null ? 0 : Date.parse(c.ring.respondedAt);
    return nowMs - at <= graceMs;
  });
}

/**
 * "Busy" is deliberately narrow: only a LIVE ring blocks a new one. An `active`
 * call does not, because a tester who closes a tab without hanging up would
 * otherwise be locked out forever — and the lockout would look like a backend bug.
 */
export function findBusyCall(userId: string, nowMs: number): Call | undefined {
  return callsNewestFirst().find(
    (c) =>
      c.ring !== null &&
      isRingLive(c.ring.state) &&
      c.state === "created" &&
      Date.parse(c.ring.expiresAt) > nowMs &&
      c.participants.some((p) => p.userId === userId),
  );
}

// ---------------------------------------------------------------------------
// Call lifetime
// ---------------------------------------------------------------------------
//
// This store is in-memory and the process runs for weeks, so a call that never
// reaches `ended` is immortal and a call that reaches it is still remembered
// forever. Both bit us on 25.08.2026: c_f74783a70042 was created at 17:48 the
// previous day and was still live the next morning, the caller's client kept
// finding it and re-joining it, and the two testers sat in different rooms
// hearing nothing while the pipeline itself worked perfectly.
//
// Nothing here can be driven by "who is in the room": the browser tells the
// backend neither "I am still here" nor "I closed the tab" once it is in one
// (web/src/main.ts hangs up the media on pagehide but posts no /end). So the
// bounds below are deliberately generous — they are a backstop against
// immortality, not a call-duration policy.

/** A call with no live ring that has outlived one of the two bounds. */
export interface DeadCall {
  call: Call;
  /** `idle` — nobody ever joined; `max_lifetime` — joined, but never hung up. */
  reason: "idle" | "max_lifetime";
}

export interface CallLifetimeLimits {
  /** How long a call nobody has joined may sit there. Measured from lastActivityAt. */
  idleMs: number;
  /** Ceiling on a joined call, measured from createdAt. */
  maxLifetimeMs: number;
}

/**
 * A ring is still the thing deciding this call's fate, so the lifetime bounds
 * must keep their hands off it. Exactly the set dueRingCalls() watches: while a
 * ring is `ringing` it owns the call whatever state the call is in (the caller
 * may already have joined and be listening to his own ringback), and an
 * `accepted` ring owns it until somebody actually joins.
 */
function ringStillGoverns(call: Call): boolean {
  if (call.ring === null || !isRingLive(call.ring.state)) return false;
  return call.ring.state === "ringing" || call.state === "created";
}

/**
 * Calls that should be ended. Pure query, for the same reason dueRingCalls() is
 * one: ending a call also has to stop a dispatched agent, and that is I/O the
 * store must not own.
 *
 * `created` means nobody has ever joined — the join handler is what flips a
 * call to `active` — so "no participants" and "state is created" are the same
 * statement here, and it is the one the rest of the backend already reasons in.
 */
export function deadCalls(nowMs: number, limits: CallLifetimeLimits): DeadCall[] {
  const out: DeadCall[] = [];
  for (const call of calls.values()) {
    if (call.state === "ended" || ringStillGoverns(call)) continue;
    if (call.state === "created") {
      if (nowMs - Date.parse(call.lastActivityAt) >= limits.idleMs) {
        out.push({ call, reason: "idle" });
      }
    } else if (nowMs - Date.parse(call.createdAt) >= limits.maxLifetimeMs) {
      out.push({ call, reason: "max_lifetime" });
    }
  }
  return out;
}

export interface ArchiveLimits {
  /**
   * How long an ended call stays in the live map before it moves to the
   * archive. It is over the moment it ends — this window only keeps it
   * queryable through the ordinary call route, so a client that lost the race
   * can still be told WHY it ended.
   */
  archiveAfterMs: number;
  /** Hard ceiling on the size of the live map, whatever the window says. */
  maxCalls: number;
}

/**
 * Ended calls ready to leave the live map. Pure query: the records are written
 * to durable storage before they are dropped from memory, and that write is I/O
 * the store must not own. The caller hands the ids back to forgetCalls() once
 * they are safely stored.
 *
 * Oldest first, so a store over its ceiling sheds the least interesting calls.
 */
export function archivableCalls(nowMs: number, limits: ArchiveLimits): Call[] {
  const due: Call[] = [];
  const rest: Call[] = [];
  // Map entries stay in insertion order, so this walks oldest-first.
  for (const call of calls.values()) {
    if (call.state !== "ended") continue;
    const endedMs = Date.parse(call.endedAt ?? call.lastActivityAt);
    if (nowMs - endedMs >= limits.archiveAfterMs) due.push(call);
    else rest.push(call);
  }
  // Over the ceiling, ended calls leave early rather than waiting out their
  // window: a burst inside one window must not be able to grow the map without
  // limit. Live calls are never touched — dropping one would 404 a call two
  // people are in — so a store full of live calls simply stops shrinking, which
  // is a bounded and visible condition rather than a leak.
  let over = calls.size - due.length - limits.maxCalls;
  for (const call of rest) {
    if (over <= 0) break;
    due.push(call);
    over -= 1;
  }
  return due;
}

/** Drop calls from the live map. Returns how many were actually there. */
export function forgetCalls(callIds: readonly string[]): number {
  let dropped = 0;
  for (const id of callIds) {
    if (calls.delete(id)) dropped += 1;
  }
  return dropped;
}

/** How many calls the store is holding, split by whether they are still live. */
export function callCounts(): { live: number; ended: number } {
  let live = 0;
  let ended = 0;
  for (const call of calls.values()) {
    if (call.state === "ended") ended += 1;
    else live += 1;
  }
  return { live, ended };
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export function touchPresence(userId: string, nowMs: number): PresenceRecord {
  const record: PresenceRecord = { userId, lastSeenMs: nowMs };
  presence.set(userId, record);
  return record;
}

/** Explicit goodbye (tab close / "I am leaving"), so the peer does not wait out the TTL. */
export function dropPresence(userId: string): void {
  presence.delete(userId);
}

export function getPresence(userId: string): PresenceRecord | undefined {
  return presence.get(userId);
}
