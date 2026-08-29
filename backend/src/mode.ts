import type { CallMode, ContactOverrides, Gender, Lang, ModeReason, Tone, UserProfile } from "./types.js";

export interface ModeDecision {
  mode: CallMode;
  reason: ModeReason;
}

/**
 * "Language is a property of the contact": the override that describes user X is the one
 * stored on the card the OTHER side keeps for X — contact(peer -> X).overrides — layered
 * over X's own profile. Passing `undefined` yields the raw profile value.
 */
export function effectiveLang(profile: UserProfile, overrides?: ContactOverrides): Lang {
  return overrides?.lang ?? profile.lang;
}

export function effectiveGender(profile: UserProfile, overrides?: ContactOverrides): Gender {
  return overrides?.gender ?? profile.gender;
}

export function effectiveTone(profile: UserProfile, overrides?: ContactOverrides): Tone {
  return overrides?.tone ?? profile.tone;
}

export function decideMode(langA: Lang, langB: Lang, force: boolean): ModeDecision {
  if (force) return { mode: "FORCED", reason: "forced_by_user" };
  if (langA === langB) return { mode: "DIRECT", reason: "languages_match" };
  return { mode: "TRANSLATED", reason: "languages_differ" };
}
